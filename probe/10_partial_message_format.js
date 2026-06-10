// Probe 10 — --include-partial-messages event shape
//
// Verifies: with --include-partial-messages, what extra events arrive?
// Goal: design streamParser.js's partial-aggregation logic.
//
// We ask claude for a multi-sentence answer so deltas are likely.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LOG_DIR = path.join(__dirname, 'log');
const SUMMARY_PATH = path.join(LOG_DIR, '10.summary.json');

function buildUserMessage(text) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
}

(async () => {
  const logPath = path.join(LOG_DIR, '10.ndjson');
  const logStream = fs.createWriteStream(logPath, { flags: 'w' });

  const t0 = Date.now();
  const child = spawn('claude', [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', 'dontAsk',
  ], {
    cwd: process.cwd(),
    env: { ...process.env },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  console.log('[probe 10] claude pid =', child.pid);

  try {
    child.stdin.write(JSON.stringify(buildUserMessage(
      'In 3-4 sentences, explain what a process tree is. Keep it simple.'
    )) + '\n');
  } catch {}

  let buf = '';
  const events = [];
  const eventTypeCounts = {};
  const partialEvents = [];
  let fullAssistantText = '';
  let resultPayload = null;
  let firstStreamEventAt = null;
  let firstAssistantAt = null;
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

        if (ev.type === 'stream_event') {
          if (firstStreamEventAt === null) firstStreamEventAt = Date.now() - t0;
          partialEvents.push({
            at: Date.now() - t0,
            event: ev.event,
            keys: Object.keys(ev),
          });
        } else if (ev.type === 'assistant') {
          if (firstAssistantAt === null) firstAssistantAt = Date.now() - t0;
          if (ev.message && Array.isArray(ev.message.content)) {
            for (const c of ev.message.content) {
              if (c.type === 'text') fullAssistantText += c.text;
            }
          }
        } else if (ev.type === 'result') {
          resultPayload = { is_error: ev.is_error, subtype: ev.subtype, result_text: ev.result };
          wrappedFinish();
        }
      } catch {}
    }
  });

  child.stderr.on('data', (chunk) => logStream.write(`[STDERR] ${chunk}`));
  child.on('exit', (code) => {
    logStream.end();

    // Reconstruct streamed text from partials and compare
    const streamedText = partialEvents
      .filter(p => p.event?.delta?.type === 'text_delta')
      .map(p => p.event.delta.text)
      .join('');

    const summary = {
      probe: '10_partial_message_format',
      runAt: new Date().toISOString(),
      claudeExitCode: code,
      firstStreamEventAt,
      firstAssistantAt,
      partialEventCount: partialEvents.length,
      partialEventSubtypes: [...new Set(partialEvents.map(p => p.event?.type + ':' + (p.event?.delta?.type || p.event?.content_block?.type || '?')))],
      partialEventSampleFirst3: partialEvents.slice(0, 3).map(p => p.event),
      partialEventSampleLast3: partialEvents.slice(-3).map(p => p.event),
      reconstructedTextLen: streamedText.length,
      fullAssistantTextLen: fullAssistantText.length,
      textsMatch: streamedText === fullAssistantText,
      streamedText: streamedText.slice(0, 500),
      fullAssistantText: fullAssistantText.slice(0, 500),
      eventTypeCounts,
      resultPayload,
    };
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
    console.log('\n[probe 10] partial events:', partialEvents.length);
    console.log('[probe 10] partial subtypes:', summary.partialEventSubtypes);
    console.log('[probe 10] streamed=full?', summary.textsMatch);
    console.log('[probe 10] full text:', fullAssistantText.slice(0, 300));
  });

  setTimeout(() => { if (!finished) { console.log('[probe 10] timeout'); wrappedFinish(); } }, 60000);
})();
