// Probe 03 — --resume cross-process (text mode baseline)
//
// Validates: a session created in process A can be continued in a fresh
// process B via `claude --resume <session_id>` after A has fully exited.
//
// Two stages, sequential:
//   A) spawn `claude -p "remember: ..." --output-format stream-json --verbose`
//      → capture session_id from system/init → wait for exit
//   B) spawn `claude -p "what color did i mention?" --resume <id> --output-format stream-json --verbose`
//      → capture assistant text → judge if continuity preserved
//
// Outputs:
//   - probe/log/03-A.ndjson, 03-B.ndjson
//   - probe/log/03.summary.json
//   - probe/log/03-B.assistant.txt  (for human eyeballing)

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LOG_DIR = path.join(__dirname, 'log');
const SUMMARY_PATH = path.join(LOG_DIR, '03.summary.json');

const MEMORY_PHRASE = 'My favorite color is azure-blue, please remember it.';
const RECALL_QUESTION = 'What was the color I just told you to remember? Reply with only the color name.';

function runStage(stage, args) {
  return new Promise((resolve) => {
    const logPath = path.join(LOG_DIR, `03-${stage}.ndjson`);
    const logStream = fs.createWriteStream(logPath, { flags: 'w' });

    console.log(`\n[probe 03 / ${stage}] spawn: claude ${args.join(' ')}`);
    const t0 = Date.now();
    const child = spawn('claude', args, {
      cwd: process.cwd(),
      env: { ...process.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log(`[probe 03 / ${stage}] pid =`, child.pid);

    let buf = '';
    const events = [];
    const eventTypeCounts = {};
    let sessionId = null;
    let resultPayload = null;
    let assistantTexts = [];

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
            console.log(`[probe 03 / ${stage}] init session_id =`, sessionId);
          } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
            for (const c of ev.message.content) {
              if (c.type === 'text') assistantTexts.push(c.text);
            }
          } else if (ev.type === 'result') {
            resultPayload = {
              is_error: ev.is_error,
              subtype: ev.subtype,
              num_turns: ev.num_turns,
              result_text: ev.result,
              duration_ms: ev.duration_ms,
              session_id: ev.session_id,
              total_cost_usd: ev.total_cost_usd,
            };
          }
        } catch (e) {
          console.error(`[probe 03 / ${stage}] parse error:`, e.message);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      logStream.write(`[STDERR] ${s}\n`);
      process.stderr.write(`[probe 03 / ${stage} stderr] ${s}`);
    });

    child.on('error', (err) => {
      console.error(`[probe 03 / ${stage}] spawn error:`, err);
      logStream.end();
      resolve({ stage, error: err.message });
    });

    child.on('exit', (code, signal) => {
      console.log(`[probe 03 / ${stage}] exit code=`, code, 'signal=', signal);
      logStream.end();
      resolve({
        stage,
        exitCode: code,
        signal,
        elapsedMs: Date.now() - t0,
        sessionId,
        eventTypeCounts,
        resultPayload,
        assistantTexts,
      });
    });

    setTimeout(() => {
      if (child.exitCode === null) {
        console.log(`[probe 03 / ${stage}] timeout 60s, killing`);
        try { child.kill(); } catch {}
      }
    }, 60000);
  });
}

(async () => {
  // Stage A: plant the memory
  const a = await runStage('A', [
    '-p', MEMORY_PHRASE,
    '--output-format', 'stream-json',
    '--verbose',
  ]);
  console.log('\n[probe 03 / A] session_id =', a.sessionId);
  console.log('[probe 03 / A] assistant texts =', a.assistantTexts);

  if (!a.sessionId) {
    console.error('[probe 03] no session_id from A, aborting');
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify({ probe: '03', failure: 'no_session_id_from_A', a }, null, 2));
    process.exit(2);
  }

  // Brief gap to ensure process A is fully reaped
  await new Promise(r => setTimeout(r, 500));

  // Stage B: ask the recall question with --resume
  const b = await runStage('B', [
    '-p', RECALL_QUESTION,
    '--resume', a.sessionId,
    '--output-format', 'stream-json',
    '--verbose',
  ]);
  console.log('\n[probe 03 / B] session_id =', b.sessionId);
  console.log('[probe 03 / B] assistant texts =', b.assistantTexts);

  const allText = (b.assistantTexts.join(' ') + ' ' + (b.resultPayload?.result_text || '')).toLowerCase();
  const recalled = allText.includes('azure') || allText.includes('blue');
  const verdict = recalled ? 'RESUME_WORKS' : 'RESUME_FAILED';

  const summary = {
    probe: '03_resume_via_session_id',
    runAt: new Date().toISOString(),
    memoryPhrase: MEMORY_PHRASE,
    recallQuestion: RECALL_QUESTION,
    stageA: a,
    stageB: b,
    bAssistantSawColor: recalled,
    verdict,
  };
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(LOG_DIR, '03-B.assistant.txt'), b.assistantTexts.join('\n---\n'));
  console.log('\n[probe 03] VERDICT:', verdict);
  console.log('[probe 03] summary written to', SUMMARY_PATH);
})();
