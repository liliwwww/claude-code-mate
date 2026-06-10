// Probe 06 — proxy injection: positive + negative path
//
// Tests:
//   POS) spawn with HTTP_PROXY explicitly set → success expected
//   NEG) spawn with HTTP_PROXY / HTTPS_PROXY scrubbed → identify failure shape
//
// In the negative case, we want to characterize:
//   - Does claude produce any stream-json error event?
//   - Does it write to stderr?
//   - What's the exit code?
//   - How long does it hang before giving up?
//
// This drives SpawnManager error surfacing logic.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LOG_DIR = path.join(__dirname, 'log');
const SUMMARY_PATH = path.join(LOG_DIR, '06.summary.json');

function buildUserMessage(text) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
}

function scrubProxy(env) {
  const out = { ...env };
  for (const k of Object.keys(out)) {
    const lk = k.toLowerCase();
    if (lk === 'http_proxy' || lk === 'https_proxy' || lk === 'all_proxy') {
      delete out[k];
    }
  }
  return out;
}

function runCase(caseId, envFn, timeoutMs) {
  return new Promise((resolve) => {
    const logPath = path.join(LOG_DIR, `06-${caseId}.ndjson`);
    const logStream = fs.createWriteStream(logPath, { flags: 'w' });

    const env = envFn(process.env);
    console.log(`\n[probe 06 / ${caseId}] HTTP_PROXY =`, env.HTTP_PROXY || '(unset)');
    console.log(`[probe 06 / ${caseId}] HTTPS_PROXY =`, env.HTTPS_PROXY || '(unset)');

    const t0 = Date.now();
    const child = spawn('claude', [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'dontAsk',
    ], {
      cwd: process.cwd(),
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(`[probe 06 / ${caseId}] pid =`, child.pid);

    try {
      child.stdin.write(JSON.stringify(buildUserMessage('reply only the word: hello')) + '\n');
    } catch {}

    let buf = '';
    const events = [];
    const eventTypeCounts = {};
    const stderrChunks = [];
    let sessionId = null;
    let assistantTexts = [];
    let resultPayload = null;
    let firstByteAt = null;
    let finished = false;

    const wrappedFinish = () => {
      if (finished) return;
      finished = true;
      try { child.stdin.end(); } catch {}
      setTimeout(() => { if (child.exitCode === null) try { child.kill(); } catch {} }, 1000);
    };

    child.stdout.on('data', (chunk) => {
      if (firstByteAt === null) firstByteAt = Date.now() - t0;
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
          } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
            for (const c of ev.message.content) if (c.type === 'text') assistantTexts.push(c.text);
          } else if (ev.type === 'result') {
            resultPayload = { is_error: ev.is_error, subtype: ev.subtype, result_text: ev.result, api_error_status: ev.api_error_status };
            wrappedFinish();
          } else if (ev.type === 'system' && ev.subtype === 'api_retry') {
            console.log(`[probe 06 / ${caseId}] api_retry seen:`, JSON.stringify(ev).slice(0, 300));
          } else if (ev.type === 'system' && ev.subtype === 'error') {
            console.log(`[probe 06 / ${caseId}] system/error:`, JSON.stringify(ev).slice(0, 300));
          }
        } catch {}
      }
    });

    child.stderr.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      stderrChunks.push(s);
      logStream.write(`[STDERR] ${s}\n`);
      process.stderr.write(`[probe 06 / ${caseId} stderr] ${s}`);
    });

    child.on('error', (err) => {
      console.error(`[probe 06 / ${caseId}] spawn error:`, err);
      resolve({ caseId, error: err.message });
    });

    child.on('exit', (code, signal) => {
      logStream.end();
      console.log(`[probe 06 / ${caseId}] exit code=`, code, 'signal=', signal, 'elapsed=', Date.now() - t0, 'ms');
      resolve({
        caseId,
        exitCode: code,
        signal,
        elapsedMs: Date.now() - t0,
        firstByteMs: firstByteAt,
        envHadHttpProxy: !!env.HTTP_PROXY,
        sessionId,
        eventTypeCounts,
        assistantTexts,
        resultPayload,
        stderrSnippet: stderrChunks.join('').slice(0, 1000),
        stderrBytes: stderrChunks.join('').length,
      });
    });

    setTimeout(() => {
      if (!finished) {
        console.log(`[probe 06 / ${caseId}] timeout ${timeoutMs}ms`);
        wrappedFinish();
      }
    }, timeoutMs);
  });
}

(async () => {
  const pos = await runCase('POS', (env) => ({ ...env }), 60000);
  await new Promise(r => setTimeout(r, 500));
  const neg = await runCase('NEG', (env) => scrubProxy(env), 60000);

  const summary = {
    probe: '06_proxy_injection',
    runAt: new Date().toISOString(),
    positive: pos,
    negative: neg,
    verdict: {
      proxyPresentSucceeds: pos.resultPayload?.is_error === false && pos.exitCode === 0,
      proxyAbsentFails: neg.exitCode !== 0 || neg.resultPayload?.is_error === true,
      negativeFailureSurface: {
        exitCode: neg.exitCode,
        firstByteMs: neg.firstByteMs,
        sawSystemInit: !!neg.sessionId,
        sawResult: !!neg.resultPayload,
        resultIsError: neg.resultPayload?.is_error,
        resultApiErrorStatus: neg.resultPayload?.api_error_status,
        eventTypeCounts: neg.eventTypeCounts,
        stderrBytes: neg.stderrBytes,
        stderrSnippetFirst200: neg.stderrSnippet?.slice(0, 200),
      },
    },
  };
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  console.log('\n[probe 06] VERDICT:', JSON.stringify(summary.verdict, null, 2));
})();
