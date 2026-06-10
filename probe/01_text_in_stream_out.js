// Probe 01 — baseline: text input via -p arg + stream-json output via stdout
//
// Validates:
//  - claude CLI is reachable from Node child_process.spawn (array args)
//  - HTTP_PROXY / HTTPS_PROXY env vars are inherited by the child
//  - stream-json output produces NDJSON events on stdout
//  - We can identify event types and capture session_id from system/init
//
// Outputs:
//  - probe/log/01.ndjson  (raw NDJSON stream verbatim)
//  - probe/log/01.summary.json  (parsed event summary)
//
// Run:
//  $env:HTTP_PROXY = "http://127.0.0.1:10808"; $env:HTTPS_PROXY = "http://127.0.0.1:10808"
//  node probe/01_text_in_stream_out.js

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LOG_PATH = path.join(__dirname, 'log', '01.ndjson');
const SUMMARY_PATH = path.join(__dirname, 'log', '01.summary.json');

if (!process.env.HTTP_PROXY) {
  console.warn('[warn] HTTP_PROXY not set in env — claude may fail to reach api.anthropic.com');
}

console.log('[probe 01] spawning claude...');
console.log('[probe 01] HTTP_PROXY =', process.env.HTTP_PROXY);
console.log('[probe 01] cwd =', process.cwd());

const t0 = Date.now();
const child = spawn('claude', [
  '-p', 'say only the word: pong',
  '--output-format', 'stream-json',
  '--verbose',
], {
  cwd: process.cwd(),
  env: { ...process.env },          // proxy passthrough
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'], // no stdin for this probe
});

console.log('[probe 01] spawned pid =', child.pid);

const logStream = fs.createWriteStream(LOG_PATH, { flags: 'w' });

// Line-buffered NDJSON parser (mirrors what streamParser.js will do)
let buf = '';
const events = [];
const eventTypeCounts = {};
let sessionId = null;
let firstByteAt = null;
let firstEventAt = null;

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
      if (firstEventAt === null) firstEventAt = Date.now() - t0;
      const key = ev.type + (ev.subtype ? '/' + ev.subtype : '');
      eventTypeCounts[key] = (eventTypeCounts[key] || 0) + 1;
      events.push({ at: Date.now() - t0, type: key, keys: Object.keys(ev) });
      if (ev.type === 'system' && ev.subtype === 'init' && ev.session_id) {
        sessionId = ev.session_id;
        console.log('[probe 01] system/init session_id =', sessionId);
        console.log('[probe 01] system/init keys =', Object.keys(ev).join(', '));
      }
    } catch (e) {
      console.error('[probe 01] parse error:', e.message, 'line:', line.slice(0, 200));
    }
  }
});

child.stderr.on('data', (chunk) => {
  process.stderr.write('[claude stderr] ' + chunk.toString('utf8'));
});

child.on('error', (err) => {
  console.error('[probe 01] spawn error:', err);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  const elapsed = Date.now() - t0;
  console.log('[probe 01] exit code =', code, 'signal =', signal, 'elapsed =', elapsed, 'ms');

  logStream.end();

  const summary = {
    probe: '01_text_in_stream_out',
    runAt: new Date().toISOString(),
    elapsedMs: elapsed,
    firstByteMs: firstByteAt,
    firstEventMs: firstEventAt,
    exitCode: code,
    signal,
    httpProxy: process.env.HTTP_PROXY || null,
    sessionId,
    eventTypeCounts,
    eventsCount: events.length,
    eventsTimeline: events,
  };
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  console.log('[probe 01] summary written to', SUMMARY_PATH);
  console.log('[probe 01] event type counts:', JSON.stringify(eventTypeCounts));
});
