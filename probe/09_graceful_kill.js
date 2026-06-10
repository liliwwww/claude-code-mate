// Probe 09 — graceful kill & process tree on Windows
//
// Verifies that we can cleanly shut down a claude child process AND
// any descendants (claude may spawn its own children for tool calls).
//
// Strategy levels (escalation):
//   L1) stdin.end()  → claude reads EOF, hopefully exits
//   L2) child.kill() (SIGTERM, becomes TerminateProcess on Win)
//   L3) `taskkill /F /T /PID <pid>` (nuke the tree)
//
// We test:
//   A) Spawn claude headless, do nothing, stdin.end → measure exit time/cleanliness
//   B) Spawn claude, ask it to start a long sleep via PowerShell tool, then kill
//      via L2 → check if PowerShell child window also dies
//   C) Same as B but use L3 (taskkill /F /T) → expect entire tree dead
//
// We track child PIDs via wmic before kill, then verify they're gone after.

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LOG_DIR = path.join(__dirname, 'log');
const SUMMARY_PATH = path.join(LOG_DIR, '09.summary.json');

function buildUserMessage(text) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
}

function pidsAlive(pids) {
  if (!pids.length) return [];
  try {
    const out = execSync(`tasklist /FI "PID eq ${pids[0]}" /FO CSV /NH`, { stdio: 'pipe' }).toString();
    // For multiple, do separately
    const alive = [];
    for (const p of pids) {
      try {
        const o = execSync(`tasklist /FI "PID eq ${p}" /FO CSV /NH`, { stdio: 'pipe' }).toString();
        if (o.toLowerCase().includes(`"${p}"`)) alive.push(p);
      } catch {}
    }
    return alive;
  } catch {
    return [];
  }
}

function getChildPids(parentPid) {
  try {
    const out = execSync(`wmic process where (ParentProcessId=${parentPid}) get ProcessId /format:csv`, { stdio: 'pipe' }).toString();
    const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
    const pids = [];
    for (const l of lines) {
      const parts = l.split(',');
      const p = parseInt(parts[parts.length - 1], 10);
      if (Number.isFinite(p) && p > 0) pids.push(p);
    }
    return pids;
  } catch {
    return [];
  }
}

function getDescendantPids(rootPid) {
  // BFS
  const seen = new Set();
  const queue = [rootPid];
  const result = [];
  while (queue.length) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    if (pid !== rootPid) result.push(pid);
    for (const c of getChildPids(pid)) queue.push(c);
  }
  return result;
}

async function runCase(caseId, opts) {
  return new Promise((resolve) => {
    const logPath = path.join(LOG_DIR, `09-${caseId}.ndjson`);
    const logStream = fs.createWriteStream(logPath, { flags: 'w' });

    console.log(`\n[probe 09 / ${caseId}] starting`);
    const t0 = Date.now();
    const args = ['-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'dontAsk',
    ];
    if (opts.allowPowerShell) {
      args.push('--tools', 'PowerShell',
                '--settings', JSON.stringify({ permissions: { allow: ['PowerShell'] } }));
    }
    const child = spawn('claude', args, {
      cwd: process.cwd(),
      env: { ...process.env },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rootPid = child.pid;
    console.log(`[probe 09 / ${caseId}] claude pid=`, rootPid);

    // Write the prompt (if any)
    if (opts.userText) {
      try { child.stdin.write(JSON.stringify(buildUserMessage(opts.userText)) + '\n'); } catch {}
    }

    let buf = '';
    let toolUsesSeen = 0;
    let killed = false;
    let descendantsBeforeKill = [];
    let descendantsAfterKill = [];
    let killStartAt = null;
    let exitAt = null;
    const eventTypeCounts = {};
    let sawInit = false;

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

          if (ev.type === 'system' && ev.subtype === 'init') sawInit = true;
          if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
            for (const c of ev.message.content) {
              if (c.type === 'tool_use') toolUsesSeen++;
            }
          }
          // For case B/C: kill once we see a tool_use happen (claude is busy doing something)
          if (opts.killOnFirstToolUse && toolUsesSeen >= 1 && !killed) {
            scheduleKill();
          }
        } catch {}
      }
    });

    child.stderr.on('data', (chunk) => logStream.write(`[STDERR] ${chunk}`));

    child.on('exit', (code, signal) => {
      exitAt = Date.now() - t0;
      console.log(`[probe 09 / ${caseId}] claude exit code=${code} signal=${signal} t=${exitAt}ms`);
      logStream.end();

      // Re-check descendants AFTER exit
      setTimeout(() => {
        descendantsAfterKill = getDescendantPids(rootPid);
        const aliveAfter = pidsAlive(descendantsBeforeKill);
        const summary = {
          caseId,
          rootPid,
          exitCode: code,
          signal,
          totalMs: exitAt,
          killStartAt,
          killMethod: opts.killMethod,
          killedExplicitly: killed,
          sawInit,
          toolUsesSeen,
          descendantsBeforeKillSnapshot: descendantsBeforeKill,
          descendantsStillAliveAfter: aliveAfter,
          eventTypeCounts,
        };
        resolve(summary);
      }, 1500);
    });

    function scheduleKill() {
      if (killed) return;
      killed = true;
      killStartAt = Date.now() - t0;
      console.log(`[probe 09 / ${caseId}] killing at t=${killStartAt}ms method=${opts.killMethod}`);
      descendantsBeforeKill = getDescendantPids(rootPid);
      console.log(`[probe 09 / ${caseId}] descendant PIDs:`, descendantsBeforeKill);
      try {
        if (opts.killMethod === 'L1_stdin_end') {
          try { child.stdin.end(); } catch {}
        } else if (opts.killMethod === 'L2_sigterm') {
          try { child.stdin.end(); } catch {}
          setTimeout(() => { try { child.kill(); } catch {} }, 200);
        } else if (opts.killMethod === 'L3_taskkill_tree') {
          try {
            execSync(`taskkill /F /T /PID ${rootPid}`, { stdio: 'pipe' });
          } catch (e) {
            console.log(`[probe 09 / ${caseId}] taskkill error:`, e.message);
          }
        }
      } catch (e) {
        console.error(e);
      }
    }

    // For case A (no tool use), kill after first init
    if (opts.killAfterInit) {
      const wait = setInterval(() => {
        if (sawInit) {
          clearInterval(wait);
          scheduleKill();
        }
      }, 100);
    }
    if (opts.killAfterMs) {
      setTimeout(scheduleKill, opts.killAfterMs);
    }

    // Safety timeout
    setTimeout(() => {
      if (child.exitCode === null) {
        console.log(`[probe 09 / ${caseId}] safety timeout, taskkill tree`);
        try { execSync(`taskkill /F /T /PID ${rootPid}`, { stdio: 'pipe' }); } catch {}
      }
    }, 60000);
  });
}

(async () => {
  // Case A: no work, kill via stdin.end after init
  const a = await runCase('A_stdin_end', {
    userText: null,
    killAfterInit: true,
    killMethod: 'L1_stdin_end',
  });

  // Case B: claude doing a long sleep, kill via SIGTERM
  const b = await runCase('B_sigterm_during_tool', {
    allowPowerShell: true,
    userText: 'Use the PowerShell tool to run this: Start-Sleep -Seconds 20. Wait for it to complete before replying.',
    killOnFirstToolUse: true,
    killMethod: 'L2_sigterm',
  });

  // Case C: same as B but L3 taskkill tree
  const c = await runCase('C_taskkill_tree', {
    allowPowerShell: true,
    userText: 'Use the PowerShell tool to run this: Start-Sleep -Seconds 20. Wait for it to complete before replying.',
    killOnFirstToolUse: true,
    killMethod: 'L3_taskkill_tree',
  });

  const summary = {
    probe: '09_graceful_kill',
    runAt: new Date().toISOString(),
    cases: [a, b, c],
    verdict: {
      L1_clean: a.exitCode === 0 && a.descendantsStillAliveAfter.length === 0,
      L2_descendants_orphaned: b.descendantsStillAliveAfter.length > 0,
      L3_kills_tree: c.descendantsStillAliveAfter.length === 0,
    },
  };
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  console.log('\n[probe 09] VERDICT:', JSON.stringify(summary.verdict, null, 2));
  for (const k of ['L1', 'L2', 'L3']) {
    const cc = summary.cases.find(c => c.killMethod.startsWith(k));
    if (cc) console.log(`  ${cc.killMethod}: descendants before=${cc.descendantsBeforeKillSnapshot.length} after=${cc.descendantsStillAliveAfter.length}`);
  }
})();
