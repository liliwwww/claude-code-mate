// Probe 05 — slash command via stream-json stdin
//
// Tests whether a user-defined slash command in .claude/commands/<name>.md is
// expanded when sent as the first stdin user message in --input-format stream-json mode.
//
// Setup precondition: D:\dev\claude_code_mate\.claude\commands\probe05-greet.md
// exists and contains an instruction to reply with "PROBE_05_MARKER_OK".
//
// Tests two payload styles:
//   I) Just the bare slash command:  "/probe05-greet"
//  II) Slash command with args style: "/probe05-greet please"
//
// PASS criterion: assistant output contains "PROBE_05_MARKER_OK".
// FAIL: claude treats /probe05-greet as literal text or errors.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LOG_DIR = path.join(__dirname, 'log');
const SUMMARY_PATH = path.join(LOG_DIR, '05.summary.json');
const MARKER = 'PROBE_05_MARKER_OK';

function buildUserMessage(text) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function runCase(caseId, userText) {
  return new Promise((resolve) => {
    const logPath = path.join(LOG_DIR, `05-${caseId}.ndjson`);
    const logStream = fs.createWriteStream(logPath, { flags: 'w' });

    console.log(`\n[probe 05 / ${caseId}] stdin: ${userText}`);
    const t0 = Date.now();
    const child = spawn('claude', [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--replay-user-messages',
      '--permission-mode', 'dontAsk',
    ], {
      cwd: process.cwd(),
      env: { ...process.env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(`[probe 05 / ${caseId}] pid =`, child.pid);

    try {
      child.stdin.write(JSON.stringify(buildUserMessage(userText)) + '\n');
    } catch (e) {
      console.error(`[probe 05 / ${caseId}] stdin write error:`, e.message);
    }

    let buf = '';
    const events = [];
    const eventTypeCounts = {};
    let sessionId = null;
    let slashCommandsFromInit = null;
    let assistantTexts = [];
    let userEchoText = null;
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

          if (ev.type === 'system' && ev.subtype === 'init') {
            sessionId = ev.session_id;
            slashCommandsFromInit = ev.slash_commands;
            console.log(`[probe 05 / ${caseId}] init: slash_commands includes probe05-greet:`,
              slashCommandsFromInit?.includes('probe05-greet'));
          } else if (ev.type === 'user') {
            try {
              const c = ev.message?.content;
              if (Array.isArray(c)) userEchoText = c.map(x => x.text || '').join(' ');
              else if (typeof c === 'string') userEchoText = c;
            } catch {}
          } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
            for (const c of ev.message.content) {
              if (c.type === 'text') assistantTexts.push(c.text);
            }
          } else if (ev.type === 'result') {
            resultPayload = {
              is_error: ev.is_error,
              subtype: ev.subtype,
              result_text: ev.result,
              num_turns: ev.num_turns,
              duration_ms: ev.duration_ms,
            };
            wrappedFinish();
          }
        } catch (e) {
          console.error(`[probe 05 / ${caseId}] parse error:`, e.message);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      logStream.write(`[STDERR] ${s}\n`);
      process.stderr.write(`[probe 05 / ${caseId} stderr] ${s}`);
    });

    child.on('error', (err) => { console.error(`[probe 05 / ${caseId}] spawn error:`, err); resolve({ caseId, error: err.message }); });
    child.on('exit', (code, signal) => {
      logStream.end();
      const allText = (assistantTexts.join(' ') + ' ' + (resultPayload?.result_text || ''));
      const expanded = allText.includes(MARKER);
      resolve({
        caseId,
        userText,
        exitCode: code,
        signal,
        elapsedMs: Date.now() - t0,
        sessionId,
        slashCommandsFromInit: slashCommandsFromInit?.slice(0, 60),
        slashCommandsCount: slashCommandsFromInit?.length,
        slashCommandsIncludesProbe05: slashCommandsFromInit?.includes('probe05-greet'),
        userEchoText,
        assistantTexts,
        resultPayload,
        eventTypeCounts,
        expansionDetected: expanded,
      });
    });

    setTimeout(() => { if (!finished) { console.log(`[probe 05 / ${caseId}] timeout 60s`); wrappedFinish(); } }, 60000);
  });
}

(async () => {
  const cases = [
    { id: 'I', text: '/probe05-greet' },
    { id: 'II', text: '/probe05-greet please' },
  ];

  const results = [];
  for (const c of cases) {
    results.push(await runCase(c.id, c.text));
  }

  const summary = {
    probe: '05_slash_command_in_stream',
    runAt: new Date().toISOString(),
    cwd: process.cwd(),
    commandFile: '.claude/commands/probe05-greet.md',
    cases: results,
    verdict: results.every(r => r.expansionDetected) ? 'SLASH_COMMAND_WORKS_IN_STREAM'
            : results.some(r => r.expansionDetected) ? 'PARTIAL'
            : 'SLASH_COMMAND_FAILED',
  };
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));

  for (const r of results) {
    console.log(`\n[probe 05 / ${r.caseId}] expanded=${r.expansionDetected}`);
    console.log(`[probe 05 / ${r.caseId}] slash_commands has probe05-greet:`, r.slashCommandsIncludesProbe05);
    console.log(`[probe 05 / ${r.caseId}] user echo:`, r.userEchoText?.slice(0, 200));
    console.log(`[probe 05 / ${r.caseId}] assistant:`, r.assistantTexts);
  }
  console.log('\n[probe 05] VERDICT:', summary.verdict);
})();
