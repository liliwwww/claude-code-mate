// Probe 02 — stdin JSON schema discovery
//
// Tests 3 candidate user-message schemas on claude -p --input-format stream-json.
// Uses --replay-user-messages so claude echoes accepted user messages on stdout,
// making it obvious which schema was accepted vs ignored vs errored.
//
// Candidates (one per process, sequentially):
//   A) Simple:                {"type":"user","message":"hello A"}
//   B) Anthropic Messages:    {"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello B"}]}}
//   C) Nested string-content: {"type":"user","message":{"role":"user","content":"hello C"}}
//
// For each candidate:
//   - spawn fresh claude with stream-json IN+OUT
//   - write candidate JSON to stdin then newline
//   - wait for 'result' event OR 10s timeout
//   - capture all events to log/02-<candidate>.ndjson
//   - record whether candidate was echoed back (replayed)
//
// Outputs:
//   - probe/log/02-A.ndjson, 02-B.ndjson, 02-C.ndjson
//   - probe/log/02.summary.json  (which candidate wins)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LOG_DIR = path.join(__dirname, 'log');
const SUMMARY_PATH = path.join(LOG_DIR, '02.summary.json');

const CANDIDATES = [
  {
    id: 'A',
    description: 'Simple {type,message:string}',
    payload: { type: 'user', message: 'reply only the word: alpha' },
  },
  {
    id: 'B',
    description: 'Anthropic Messages API shape',
    payload: {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'reply only the word: bravo' }],
      },
    },
  },
  {
    id: 'C',
    description: 'Nested with string content',
    payload: {
      type: 'user',
      message: { role: 'user', content: 'reply only the word: charlie' },
    },
  },
];

function runCandidate(cand) {
  return new Promise((resolve) => {
    const logPath = path.join(LOG_DIR, `02-${cand.id}.ndjson`);
    const logStream = fs.createWriteStream(logPath, { flags: 'w' });

    console.log(`\n[probe 02 / ${cand.id}] ${cand.description}`);
    console.log(`[probe 02 / ${cand.id}] payload =`, JSON.stringify(cand.payload));

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

    console.log(`[probe 02 / ${cand.id}] spawned pid =`, child.pid);

    // Write stdin IMMEDIATELY — claude proceeds without stdin after ~3s.
    // Don't wait for system/init (which itself may need stdin to produce).
    const payloadLine = JSON.stringify(cand.payload) + '\n';
    try {
      child.stdin.write(payloadLine);
      console.log(`[probe 02 / ${cand.id}] stdin written (${payloadLine.length} bytes)`);
    } catch (e) {
      console.error(`[probe 02 / ${cand.id}] stdin write error:`, e.message);
    }

    let buf = '';
    const events = [];
    const eventTypeCounts = {};
    let userEchoSeen = false;
    let resultSeen = false;
    let resultPayload = null;
    let errorSeen = null;
    let initSeen = false;

    const finish = (outcome) => {
      if (child.exitCode === null) {
        try { child.stdin.end(); } catch {}
        setTimeout(() => {
          try { child.kill(); } catch {}
        }, 1000);
      }
      logStream.end();
      resolve({
        id: cand.id,
        description: cand.description,
        payload: cand.payload,
        outcome,
        elapsedMs: Date.now() - t0,
        eventsCount: events.length,
        eventTypeCounts,
        initSeen,
        userEchoSeen,
        resultSeen,
        resultPayload,
        errorSeen,
        eventsTimeline: events,
      });
    };

    let finished = false;
    const wrappedFinish = (outcome) => {
      if (finished) return;
      finished = true;
      finish(outcome);
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
          events.push({ at: Date.now() - t0, type: key, raw: ev });

          if (ev.type === 'system' && ev.subtype === 'init') {
            initSeen = true;
            console.log(`[probe 02 / ${cand.id}] init seen, session_id=`, ev.session_id);
          } else if (ev.type === 'user') {
            userEchoSeen = true;
            console.log(`[probe 02 / ${cand.id}] user echo:`, JSON.stringify(ev).slice(0, 200));
          } else if (ev.type === 'result') {
            resultSeen = true;
            resultPayload = ev;
            console.log(`[probe 02 / ${cand.id}] result:`, ev.subtype, 'is_error=', ev.is_error);
            wrappedFinish(ev.is_error ? 'result_error' : 'result_ok');
          } else if (ev.type === 'error' || (ev.type === 'system' && ev.subtype === 'error')) {
            errorSeen = ev;
            console.log(`[probe 02 / ${cand.id}] error event:`, JSON.stringify(ev).slice(0, 300));
          }
        } catch (e) {
          console.error(`[probe 02 / ${cand.id}] parse error:`, e.message);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      logStream.write(`[STDERR] ${s}\n`);
      process.stderr.write(`[probe 02 / ${cand.id} stderr] ${s}`);
    });

    child.on('error', (err) => {
      console.error(`[probe 02 / ${cand.id}] spawn error:`, err);
      wrappedFinish('spawn_error');
    });

    child.on('exit', (code, signal) => {
      console.log(`[probe 02 / ${cand.id}] exit code=`, code, 'signal=', signal);
      wrappedFinish(`exited_code_${code}`);
    });

    // Timeout: 30s — must be longer than claude's typical first response
    setTimeout(() => {
      if (!finished) {
        console.log(`[probe 02 / ${cand.id}] timeout 30s`);
        wrappedFinish('timeout');
      }
    }, 30000);
  });
}

(async () => {
  const results = [];
  for (const cand of CANDIDATES) {
    const r = await runCandidate(cand);
    // strip raw events from timeline for summary brevity (keep types only)
    results.push({
      ...r,
      eventsTimeline: r.eventsTimeline.map(e => ({ at: e.at, type: e.type })),
    });
  }

  const summary = {
    probe: '02_stream_in_stream_out',
    runAt: new Date().toISOString(),
    candidates: results,
    verdict: results.map(r => ({
      id: r.id,
      outcome: r.outcome,
      initSeen: r.initSeen,
      userEchoSeen: r.userEchoSeen,
      resultSeen: r.resultSeen,
      eventTypeCounts: r.eventTypeCounts,
    })),
  };
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  console.log('\n[probe 02] verdict:');
  console.log(JSON.stringify(summary.verdict, null, 2));
  console.log('[probe 02] summary written to', SUMMARY_PATH);
})();
