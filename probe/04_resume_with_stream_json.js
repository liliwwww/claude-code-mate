// Probe 04 — --resume combined with --input-format stream-json + --output-format stream-json
//
// This is the BLOCKING question for Phase 1: can a fresh process resume a prior
// session AND speak stream-json on stdin/stdout? If yes, the SpawnManager can
// implement "cross-process thread continuity" cleanly via --resume.
//
// If NO, fallback is history-replay: feed the full message log back as synthetic
// user/assistant messages on stdin to rebuild context (slower, more complex).
//
// Also tests --fork-session: does resume create a NEW session_id?
//
// Stages:
//   A) stream-json IN+OUT, plant memory ("turquoise-green"), capture session_id, kill
//   B1) --resume <id> + stream-json IN+OUT, NO --fork-session: ask recall, observe
//        whether session_id changes (expected: same)
//   B2) --resume <id> + stream-json IN+OUT + --fork-session: ask recall, observe
//        whether session_id changes (expected: new)
//
// Outputs:
//   probe/log/04-A.ndjson, 04-B1.ndjson, 04-B2.ndjson
//   probe/log/04.summary.json

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LOG_DIR = path.join(__dirname, 'log');
const SUMMARY_PATH = path.join(LOG_DIR, '04.summary.json');

const MEMORY_PHRASE = 'My favorite color is turquoise-green. Remember it for later.';
const RECALL_QUESTION = 'What color did I tell you to remember? Reply with only the color name.';

function buildUserMessage(text) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  };
}

function runStreamStage(stage, extraArgs, userText) {
  return new Promise((resolve) => {
    const logPath = path.join(LOG_DIR, `04-${stage}.ndjson`);
    const logStream = fs.createWriteStream(logPath, { flags: 'w' });

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--replay-user-messages',
      '--permission-mode', 'dontAsk',
      ...extraArgs,
    ];

    console.log(`\n[probe 04 / ${stage}] spawn: claude ${args.join(' ')}`);
    const t0 = Date.now();
    const child = spawn('claude', args, {
      cwd: process.cwd(),
      env: { ...process.env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(`[probe 04 / ${stage}] pid =`, child.pid);

    // Critical (probe 02 lesson): write stdin IMMEDIATELY, don't wait for init
    const userMsg = buildUserMessage(userText);
    const payloadLine = JSON.stringify(userMsg) + '\n';
    try {
      child.stdin.write(payloadLine);
      console.log(`[probe 04 / ${stage}] stdin written: ${userText}`);
    } catch (e) {
      console.error(`[probe 04 / ${stage}] stdin write error:`, e.message);
    }

    let buf = '';
    const events = [];
    const eventTypeCounts = {};
    let sessionId = null;
    let resultPayload = null;
    let assistantTexts = [];
    let finished = false;

    const wrappedFinish = (reason) => {
      if (finished) return;
      finished = true;
      try { child.stdin.end(); } catch {}
      setTimeout(() => {
        if (child.exitCode === null) {
          try { child.kill(); } catch {}
        }
      }, 1000);
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
            console.log(`[probe 04 / ${stage}] init session_id =`, sessionId);
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
            };
            wrappedFinish(`result_${ev.subtype}`);
          }
        } catch (e) {
          console.error(`[probe 04 / ${stage}] parse error:`, e.message);
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const s = chunk.toString('utf8');
      logStream.write(`[STDERR] ${s}\n`);
      process.stderr.write(`[probe 04 / ${stage} stderr] ${s}`);
    });

    child.on('error', (err) => {
      console.error(`[probe 04 / ${stage}] spawn error:`, err);
      logStream.end();
      resolve({ stage, error: err.message });
    });

    child.on('exit', (code, signal) => {
      console.log(`[probe 04 / ${stage}] exit code=`, code, 'signal=', signal);
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
      if (!finished) {
        console.log(`[probe 04 / ${stage}] timeout 90s`);
        wrappedFinish('timeout');
      }
    }, 90000);
  });
}

(async () => {
  // Stage A: plant memory via stream-json IN+OUT
  const a = await runStreamStage('A', [], MEMORY_PHRASE);
  console.log('\n[probe 04 / A] session_id =', a.sessionId);
  console.log('[probe 04 / A] assistant texts =', a.assistantTexts);

  if (!a.sessionId) {
    console.error('[probe 04] A failed to get session_id, aborting');
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify({ probe: '04', failure: 'no_session_id_from_A', a }, null, 2));
    process.exit(2);
  }

  await new Promise(r => setTimeout(r, 500));

  // Stage B1: --resume + stream-json IN+OUT, WITHOUT --fork-session
  const b1 = await runStreamStage('B1', ['--resume', a.sessionId], RECALL_QUESTION);
  console.log('\n[probe 04 / B1] session_id =', b1.sessionId, '(expected SAME as A)');
  console.log('[probe 04 / B1] assistant texts =', b1.assistantTexts);

  await new Promise(r => setTimeout(r, 500));

  // Stage B2: --resume + stream-json IN+OUT + --fork-session
  const b2 = await runStreamStage('B2', ['--resume', a.sessionId, '--fork-session'], RECALL_QUESTION);
  console.log('\n[probe 04 / B2] session_id =', b2.sessionId, '(expected NEW vs A)');
  console.log('[probe 04 / B2] assistant texts =', b2.assistantTexts);

  const b1Text = (b1.assistantTexts.join(' ') + ' ' + (b1.resultPayload?.result_text || '')).toLowerCase();
  const b2Text = (b2.assistantTexts.join(' ') + ' ' + (b2.resultPayload?.result_text || '')).toLowerCase();
  const b1Recalled = b1Text.includes('turquoise') || b1Text.includes('green');
  const b2Recalled = b2Text.includes('turquoise') || b2Text.includes('green');

  const summary = {
    probe: '04_resume_with_stream_json',
    runAt: new Date().toISOString(),
    memoryPhrase: MEMORY_PHRASE,
    stageA: a,
    stageB1_resumeNoFork: b1,
    stageB2_resumeWithFork: b2,
    findings: {
      streamJsonResumeWorks: b1Recalled || b2Recalled,
      noForkPreservesSessionId: a.sessionId === b1.sessionId,
      forkCreatesNewSessionId: a.sessionId !== b2.sessionId,
      b1Recalled,
      b2Recalled,
    },
    verdict: (b1Recalled || b2Recalled) ? 'RESUME_STREAM_JSON_WORKS' : 'RESUME_STREAM_JSON_FAILED',
  };
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  console.log('\n[probe 04] FINDINGS:', JSON.stringify(summary.findings, null, 2));
  console.log('[probe 04] VERDICT:', summary.verdict);
})();
