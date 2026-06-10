// Probe 08 — claude spawns a visible PowerShell window for long tasks
//
// Verifies the "long-task visible window" protocol:
//   - Claude (inside its session) invokes Start-Process powershell -ArgumentList ...
//     which pops a NEW visible PS window on the user's desktop.
//   - That window runs a script that writes a sentinel file `runlog\<id>.done`
//     containing `DONE rc=N` when finished.
//   - Both Claude itself AND the mate UI watcher can read the sentinel.
//
// We supply Claude with a precise task: open a visible PS window, run
//   "Start-Sleep 5; 'hello world' | Out-File <sentinel>; 'DONE rc=0' | Out-File <sentinel> -Append",
// and confirm sentinel is written.
//
// The probe is the harness that asks Claude to do this in one turn, then polls
// the sentinel file for up to 30s.
//
// PASS: sentinel file exists and contains "DONE rc=0" within 30s.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LOG_DIR = path.join(__dirname, 'log');
const SUMMARY_PATH = path.join(LOG_DIR, '08.summary.json');
const RUNLOG_DIR = path.join(__dirname, 'runlog');
fs.mkdirSync(RUNLOG_DIR, { recursive: true });

const sentinelPath = path.join(RUNLOG_DIR, `probe08_${Date.now()}.done`).replace(/\\/g, '/');
console.log('[probe 08] sentinel path =', sentinelPath);

// We pre-clean
try { fs.unlinkSync(sentinelPath); } catch {}

const TASK_TEXT = `
You have one job: launch a NEW visible PowerShell window that runs a 5-second sleep,
then writes a sentinel file. Use the PowerShell tool to invoke:

  Start-Process powershell -ArgumentList '-NoProfile','-Command',"Start-Sleep -Seconds 5; 'hello from visible window' | Out-File -FilePath '${sentinelPath}' -Encoding utf8; 'DONE rc=0' | Out-File -FilePath '${sentinelPath}' -Encoding utf8 -Append"

That command should return immediately (Start-Process is non-blocking).
After invoking it, reply with EXACTLY: "LAUNCHED"
Do NOT wait for the window to finish. Just launch it and reply.
`.trim();

function buildUserMessage(text) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
}

(async () => {
  const logPath = path.join(LOG_DIR, '08.ndjson');
  const logStream = fs.createWriteStream(logPath, { flags: 'w' });

  const t0 = Date.now();
  const child = spawn('claude', [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'dontAsk',
    '--tools', 'PowerShell',
    '--settings', JSON.stringify({ permissions: { allow: ['PowerShell'] } }),
  ], {
    cwd: process.cwd(),
    env: { ...process.env },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  console.log('[probe 08] claude pid =', child.pid);

  try { child.stdin.write(JSON.stringify(buildUserMessage(TASK_TEXT)) + '\n'); } catch {}

  let buf = '';
  const events = [];
  const eventTypeCounts = {};
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
            if (c.type === 'tool_use') {
              toolUsesSeen.push({ name: c.name, inputSnippet: JSON.stringify(c.input).slice(0, 500) });
              console.log(`[probe 08] tool_use: ${c.name}`);
            }
          }
        } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
          for (const c of ev.message.content) {
            if (c.type === 'tool_result') {
              const txt = typeof c.content === 'string' ? c.content
                        : Array.isArray(c.content) ? c.content.map(x => x.text || '').join('') : JSON.stringify(c.content);
              toolResultsSeen.push({ is_error: c.is_error, snippet: txt.slice(0, 500) });
              console.log(`[probe 08] tool_result is_error=${c.is_error}:`, txt.slice(0, 200));
            }
          }
        } else if (ev.type === 'result') {
          resultPayload = { is_error: ev.is_error, subtype: ev.subtype, result_text: ev.result };
          wrappedFinish();
        }
      } catch {}
    }
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[probe 08 stderr] ${chunk}`);
  });

  child.on('exit', async (code, signal) => {
    logStream.end();
    console.log(`[probe 08] claude exit code=${code} signal=${signal}`);

    // Poll for sentinel
    const deadline = Date.now() + 30000;
    let sentinelContent = null;
    let foundAt = null;
    while (Date.now() < deadline) {
      try {
        const stat = fs.statSync(sentinelPath);
        const content = fs.readFileSync(sentinelPath, 'utf8');
        if (content.includes('DONE rc=')) {
          sentinelContent = content;
          foundAt = Date.now() - t0;
          break;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }

    const summary = {
      probe: '08_long_run_visible_window',
      runAt: new Date().toISOString(),
      sentinelPath,
      sentinelFound: !!sentinelContent,
      sentinelFoundAtMs: foundAt,
      sentinelContent,
      claudeExitCode: code,
      claudeElapsedMs: child._endTime ? child._endTime - t0 : null,
      eventTypeCounts,
      toolUsesSeen,
      toolResultsSeen,
      assistantTextsHead: assistantTexts.map(t => t.slice(0, 200)),
      resultPayload,
      verdict: sentinelContent ? 'VISIBLE_WINDOW_AND_SENTINEL_WORK' : 'SENTINEL_NOT_WRITTEN',
    };
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
    console.log('\n[probe 08] VERDICT:', summary.verdict);
    console.log('[probe 08] sentinel content:', sentinelContent);
    console.log('[probe 08] tool_uses:', toolUsesSeen.length);
  });

  setTimeout(() => { if (!finished) { console.log('[probe 08] claude timeout 60s'); wrappedFinish(); } }, 60000);
})();
