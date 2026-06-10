// Probe 07 — --permission-mode dontAsk + settings allow/deny interaction
//
// We need to know: under unattended/headless run, what's the safest combination?
//
// Tests 4 cases, each asks claude to perform a Bash read-only command:
//   1) dontAsk, no settings   -> expect denial (no allow rule)
//   2) dontAsk, allow Bash    -> expect success
//   3) bypassPermissions      -> expect success (open mode)
//   4) default                -> expect prompt-like behavior (which in headless = denial)
//
// We use a tiny ephemeral Bash command: `echo PROBE_07_OK`. If executed,
// the assistant text or tool_result will contain "PROBE_07_OK".
//
// We write a temp settings.json per case via --settings <inlineJSON>.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LOG_DIR = path.join(__dirname, 'log');
const SUMMARY_PATH = path.join(LOG_DIR, '07.summary.json');
const MARKER = 'PROBE_07_OK';
const TASK_TEXT = `Run a single shell command: echo ${MARKER}. Then reply with the output you got.`;

function buildUserMessage(text) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
}

function runCase(caseId, args, settingsObj) {
  return new Promise((resolve) => {
    const logPath = path.join(LOG_DIR, `07-${caseId}.ndjson`);
    const logStream = fs.createWriteStream(logPath, { flags: 'w' });

    const fullArgs = ['-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-hook-events',
      ...args,
    ];
    if (settingsObj) {
      fullArgs.push('--settings', JSON.stringify(settingsObj));
    }

    console.log(`\n[probe 07 / ${caseId}] args:`, fullArgs.join(' '));
    const t0 = Date.now();
    const child = spawn('claude', fullArgs, {
      cwd: process.cwd(),
      env: { ...process.env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(`[probe 07 / ${caseId}] pid =`, child.pid);

    try {
      child.stdin.write(JSON.stringify(buildUserMessage(TASK_TEXT)) + '\n');
    } catch {}

    let buf = '';
    const events = [];
    const eventTypeCounts = {};
    const stderrChunks = [];
    let permissionDenialsSeen = [];
    let toolUsesSeen = [];
    let toolResultsSeen = [];
    let assistantTexts = [];
    let resultPayload = null;
    let finished = false;

    const wrappedFinish = () => {
      if (finished) return;
      finished = true;
      try { child.stdin.end(); } catch {}
      setTimeout(() => { if (child.exitCode === null) try { child.kill(); } catch {} }, 1000);
    };

    child.stdout.on('data', (chunk) => {
      logStream.write(chunk);
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          const key = ev.type + (ev.subtype ? '/' + ev.subtype : '');
          eventTypeCounts[key] = (eventTypeCounts[key] || 0) + 1;
          events.push({ at: Date.now() - t0, type: key });

          if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
            for (const c of ev.message.content) {
              if (c.type === 'text') assistantTexts.push(c.text);
              if (c.type === 'tool_use') toolUsesSeen.push({ name: c.name, inputKeys: c.input ? Object.keys(c.input) : [] });
            }
          } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
            for (const c of ev.message.content) {
              if (c.type === 'tool_result') {
                const txt = typeof c.content === 'string' ? c.content
                          : Array.isArray(c.content) ? c.content.map(x => x.text || '').join('') : JSON.stringify(c.content);
                toolResultsSeen.push({ tool_use_id: c.tool_use_id, is_error: c.is_error, snippet: txt.slice(0, 200) });
              }
            }
          } else if (ev.type === 'result') {
            resultPayload = {
              is_error: ev.is_error,
              subtype: ev.subtype,
              result_text: ev.result,
              num_turns: ev.num_turns,
              api_error_status: ev.api_error_status,
              permission_denials: ev.permission_denials,
            };
            permissionDenialsSeen = ev.permission_denials || [];
            wrappedFinish();
          }
        } catch {}
      }
    });

    child.stderr.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      stderrChunks.push(s);
      logStream.write(`[STDERR] ${s}\n`);
    });

    child.on('error', (err) => { console.error(`[probe 07 / ${caseId}] spawn error:`, err); resolve({ caseId, error: err.message }); });
    child.on('exit', (code, signal) => {
      logStream.end();
      const allText = (assistantTexts.join(' ') + ' ' + (resultPayload?.result_text || '')
        + ' ' + toolResultsSeen.map(t => t.snippet).join(' '));
      const markerSeen = allText.includes(MARKER);
      console.log(`[probe 07 / ${caseId}] exit=${code} markerSeen=${markerSeen} denials=${permissionDenialsSeen.length}`);
      resolve({
        caseId,
        exitCode: code,
        signal,
        elapsedMs: Date.now() - t0,
        eventTypeCounts,
        toolUsesSeen,
        toolResultsSeen,
        permissionDenialsSeen,
        assistantTextsHead: assistantTexts.map(t => t.slice(0, 200)),
        resultPayload,
        stderrSnippet: stderrChunks.join('').slice(0, 500),
        markerSeen,
      });
    });

    setTimeout(() => { if (!finished) { console.log(`[probe 07 / ${caseId}] timeout 90s`); wrappedFinish(); } }, 90000);
  });
}

(async () => {
  const cases = [
    { id: '1_dontAsk_noSettings', args: ['--permission-mode', 'dontAsk'], settings: null },
    { id: '2_dontAsk_allowBash',  args: ['--permission-mode', 'dontAsk'], settings: { permissions: { allow: ['Bash(echo *)'] } } },
    { id: '3_bypass_noSettings',  args: ['--permission-mode', 'bypassPermissions'], settings: null },
    { id: '4_default_noSettings', args: ['--permission-mode', 'default'], settings: null },
  ];

  const results = [];
  for (const c of cases) {
    results.push(await runCase(c.id, c.args, c.settings));
    await new Promise(r => setTimeout(r, 500));
  }

  const summary = {
    probe: '07_permission_mode_dontAsk',
    runAt: new Date().toISOString(),
    task: TASK_TEXT,
    marker: MARKER,
    cases: results,
    verdict: results.map(r => ({
      id: r.caseId,
      markerSeen: r.markerSeen,
      denials: r.permissionDenialsSeen.length,
      toolUses: r.toolUsesSeen.length,
      exitCode: r.exitCode,
    })),
  };
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  console.log('\n[probe 07] VERDICT:', JSON.stringify(summary.verdict, null, 2));
})();
