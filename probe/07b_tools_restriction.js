// Probe 07b — verify --tools / --disallowedTools as the REAL safety lever
// (since probe 07 showed --permission-mode dontAsk is permissive on headless)
//
// Case 5: --tools "Read,Grep,Glob" (Bash explicitly excluded from whitelist)
//   → echo should be DENIED
// Case 6: --disallowedTools "Bash"
//   → echo should be DENIED

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LOG_DIR = path.join(__dirname, 'log');
const SUMMARY_PATH = path.join(LOG_DIR, '07b.summary.json');
const MARKER = 'PROBE_07_OK';
const TASK_TEXT = `Run a single shell command: echo ${MARKER}. Then reply with the output you got.`;

function buildUserMessage(text) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
}

function runCase(caseId, extraArgs) {
  return new Promise((resolve) => {
    const logPath = path.join(LOG_DIR, `07b-${caseId}.ndjson`);
    const logStream = fs.createWriteStream(logPath, { flags: 'w' });

    const args = ['-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'dontAsk',
      ...extraArgs,
    ];
    console.log(`\n[probe 07b / ${caseId}] args:`, args.join(' '));

    const t0 = Date.now();
    const child = spawn('claude', args, {
      cwd: process.cwd(),
      env: { ...process.env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    try { child.stdin.write(JSON.stringify(buildUserMessage(TASK_TEXT)) + '\n'); } catch {}

    let buf = '';
    const events = [];
    const eventTypeCounts = {};
    const stderrChunks = [];
    let toolUsesSeen = [];
    let toolResultsSeen = [];
    let assistantTexts = [];
    let resultPayload = null;
    let initTools = null;
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

          if (ev.type === 'system' && ev.subtype === 'init') {
            initTools = ev.tools;
            console.log(`[probe 07b / ${caseId}] init.tools (count=${ev.tools?.length}):`, ev.tools?.slice(0, 10), '...');
          } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
            for (const c of ev.message.content) {
              if (c.type === 'text') assistantTexts.push(c.text);
              if (c.type === 'tool_use') toolUsesSeen.push({ name: c.name });
            }
          } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
            for (const c of ev.message.content) {
              if (c.type === 'tool_result') {
                const txt = typeof c.content === 'string' ? c.content
                          : Array.isArray(c.content) ? c.content.map(x => x.text || '').join('') : JSON.stringify(c.content);
                toolResultsSeen.push({ is_error: c.is_error, snippet: txt.slice(0, 200) });
              }
            }
          } else if (ev.type === 'result') {
            resultPayload = { is_error: ev.is_error, subtype: ev.subtype, result_text: ev.result, permission_denials: ev.permission_denials };
            wrappedFinish();
          }
        } catch {}
      }
    });

    child.stderr.on('data', (chunk) => stderrChunks.push(chunk.toString('utf8')));
    child.on('error', (err) => resolve({ caseId, error: err.message }));
    child.on('exit', (code) => {
      logStream.end();
      const allText = (assistantTexts.join(' ') + ' ' + (resultPayload?.result_text || '')
        + ' ' + toolResultsSeen.map(t => t.snippet).join(' '));
      const markerSeen = allText.includes(MARKER);
      console.log(`[probe 07b / ${caseId}] exit=${code} markerSeen=${markerSeen} bashInTools=${initTools?.includes('Bash')}`);
      resolve({
        caseId,
        exitCode: code,
        markerSeen,
        bashInTools: initTools?.includes('Bash'),
        toolUsesSeen,
        toolResultsSeen,
        assistantTextsHead: assistantTexts.map(t => t.slice(0, 200)),
        resultIsError: resultPayload?.is_error,
        permissionDenials: resultPayload?.permission_denials,
      });
    });

    setTimeout(() => { if (!finished) wrappedFinish(); }, 90000);
  });
}

(async () => {
  const cases = [
    { id: '5_tools_whitelist', args: ['--tools', 'Read Grep Glob'] },
    { id: '6_disallow_bash',   args: ['--disallowedTools', 'Bash'] },
  ];
  const results = [];
  for (const c of cases) {
    results.push(await runCase(c.id, c.args));
    await new Promise(r => setTimeout(r, 500));
  }
  const summary = { probe: '07b_tools_restriction', runAt: new Date().toISOString(), cases: results };
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  console.log('\n[probe 07b] verdict:', results.map(r => ({ id: r.caseId, markerSeen: r.markerSeen, bashInTools: r.bashInTools })));
})();
