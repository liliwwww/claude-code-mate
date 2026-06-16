#!/usr/bin/env node
// [需求@2026-06-16 RFC Phase 2.3] migration 后校验工具
//
// 区分"合理 lost"和"可疑 lost":
//   - 合理 lost(✓ 不报警):
//     - thread 无 dispatch_chain (老线索,Phase 2G 之前的)
//     - instance 是 B/C 且在 chain 里有 callback 段(已弹栈)
//     - instance 已 dead / disconnected 且 thread 已 verified
//   - 可疑 lost(✗ 报警):
//     - thread 有 chain,instance 也活跃,但栈上找不到 — 真问题
//
// 默认聚焦 kb_knowledge,可以 --project=<name> 改。
//
// 用法:
//   node scripts/verify-stack-migration.js
//   node scripts/verify-stack-migration.js --project=Default
//   node scripts/verify-stack-migration.js --verbose

const path = require('node:path');
const { db } = require(path.resolve(__dirname, '..', 'server', 'db'));
const TCS = require(path.resolve(__dirname, '..', 'server', 'threads', 'ThreadCallStack'));

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => {
  const m = argv.find((a) => a.startsWith(`--${n}=`));
  return m ? m.split('=')[1] : null;
};

const projectName = opt('project') || 'kb_knowledge';
const verbose = flag('verbose');

function main() {
  console.log('='.repeat(70));
  console.log(`[verify-stack-migration] project=${projectName}`);
  console.log('='.repeat(70));

  const proj = db.prepare(`SELECT id FROM projects WHERE name = ?`).get(projectName);
  if (!proj) {
    console.log(`project "${projectName}" not found`);
    process.exit(1);
  }

  // 1. 该 project 的所有 thread + 它们的栈
  const threads = db.prepare(`
    SELECT slug, stage, metadata_json, call_stack_json, outcome
    FROM threads
    WHERE project_id = ?
  `).all(proj.id);

  // 收集栈上所有 (instance_id, session_id, thread_slug, frame_role)
  const sessionsOnStacks = new Map(); // session_id → {instId, threadSlug, role}
  let threadsWithStack = 0;
  let threadsNoChain = 0;
  for (const t of threads) {
    if (!t.call_stack_json) {
      threadsNoChain++;
      continue;
    }
    threadsWithStack++;
    try {
      const stack = JSON.parse(t.call_stack_json);
      for (const f of (stack.frames || [])) {
        if (f.sessionId) {
          sessionsOnStacks.set(f.sessionId, {
            instId: f.instanceId,
            threadSlug: t.slug,
            role: f.role,
            frameStatus: f.status,
          });
        }
      }
    } catch (e) {
      console.log(`  ⚠ ${t.slug}: invalid call_stack_json`);
    }
  }

  console.log(`Threads: ${threads.length} total, ${threadsWithStack} with stack, ${threadsNoChain} no chain`);
  console.log(`Sessions on stacks: ${sessionsOnStacks.size}`);
  console.log('');

  // 2. 拿 project 所有 instance + 它们的 session_id
  const allInstances = db.prepare(`
    SELECT id, role_name, status, bound_thread_slug, claude_session_id
    FROM role_instances
    WHERE id IN (
      SELECT DISTINCT instance_id FROM messages
      WHERE instance_id IS NOT NULL
      AND thread_slug IN (SELECT slug FROM threads WHERE project_id = ?)
    )
    AND claude_session_id IS NOT NULL
  `).all(proj.id);

  console.log(`Project instances with session_id: ${allInstances.length}`);
  console.log('');

  // 3. 区分 lost
  const reasonable = [];
  const suspicious = [];

  for (const inst of allInstances) {
    if (sessionsOnStacks.has(inst.claude_session_id)) continue; // 在栈上
    // Lost — 判断是否合理
    const reason = _classifyLost(inst, threads);
    if (reason.suspicious) {
      suspicious.push({ inst, reason });
    } else {
      reasonable.push({ inst, reason });
    }
  }

  console.log(`✓ Sessions kept on stack:           ${sessionsOnStacks.size}`);
  console.log(`✓ Sessions lost-but-reasonable:     ${reasonable.length}`);
  console.log(`✗ Sessions lost-suspicious (BUG):   ${suspicious.length}`);

  if (verbose && reasonable.length) {
    console.log('');
    console.log('Reasonable lost (合理):');
    for (const { inst, reason } of reasonable) {
      console.log(`  ${inst.role_name.padEnd(8)} ${inst.id.padEnd(20)} session=${inst.claude_session_id.slice(0,12)}...  thread=${inst.bound_thread_slug||'-'} | ${reason.label}`);
    }
  }

  if (suspicious.length) {
    console.log('');
    console.log('Suspicious lost (可疑 — 需查):');
    for (const { inst, reason } of suspicious) {
      console.log(`  ✗ ${inst.role_name} ${inst.id} session=${inst.claude_session_id} thread=${inst.bound_thread_slug||'-'} | ${reason.label}`);
    }
  }

  // 4. 同时校验:role_instances 表里所有 session 仍 intact(不该被 migration 删了)
  const allRoleInstances = db.prepare(`
    SELECT COUNT(*) as n FROM role_instances
    WHERE claude_session_id IS NOT NULL
  `).get();
  console.log('');
  console.log(`role_instances 表 session_id 总数: ${allRoleInstances.n}`);
  console.log(`(本字段独立于栈,migration 不动 → 任何 session 都能 --resume 拉起)`);

  console.log('');
  console.log('='.repeat(70));
  if (suspicious.length === 0) {
    console.log('✓ PASS — kb_knowledge 所有 session 状态合理,无可疑 lost');
    process.exit(0);
  } else {
    console.log(`✗ FAIL — ${suspicious.length} suspicious lost session(s) need 查`);
    process.exit(1);
  }
}

function _classifyLost(inst, threads) {
  const thread = threads.find((t) => t.slug === inst.bound_thread_slug);

  // 1. thread 不存在
  if (!thread) {
    return { suspicious: false, label: 'thread 不存在(可能被删)' };
  }

  // 2. thread 无 chain (老 thread,Phase 2G 之前)
  if (!thread.call_stack_json) {
    return { suspicious: false, label: 'thread 无 dispatch_chain(Phase 2G 之前的老线索)' };
  }

  // 3. thread 已 verified/aborted
  if (thread.outcome === 'verified' || thread.outcome === 'aborted') {
    return { suspicious: false, label: `thread outcome=${thread.outcome},工作已完结` };
  }

  // 4. instance 是 B/C — 它们 callback 后弹栈是正常的
  if (inst.role_name === 'mate-B' || inst.role_name === 'mate-C') {
    // 看 chain 里这个 instance 有没有 callback handoff(从 metadata 取 chain)
    try {
      const meta = JSON.parse(thread.metadata_json || '{}');
      const chain = meta.dispatch_chain || [];
      const hasCallback = chain.some((s) =>
        s.kind === 'handoff' && s.fromInstanceId === inst.id &&
        (s.toRole === 'mate-H' || s.toRole?.includes('orchestrator'))
      );
      if (hasCallback) {
        return { suspicious: false, label: 'B/C 已 callback 弹栈(正常)' };
      }
    } catch {}
    // B/C 没 callback 但不在栈上 — 还能解释:可能整段从未派工到这个实例(只是数据库残留)
    // 看 chain 里 instance 有没有出现过
    try {
      const meta = JSON.parse(thread.metadata_json || '{}');
      const chain = meta.dispatch_chain || [];
      const appears = chain.some((s) =>
        (s.fromInstanceId === inst.id || s.toInstanceId === inst.id)
      );
      if (!appears) {
        return { suspicious: false, label: 'instance 从未出现在 chain(可能曾被 spawn 但未派工)' };
      }
    } catch {}
    return { suspicious: true, label: 'B/C 出现在 chain 但栈上没有,无 callback — 可疑' };
  }

  // 5. instance 是 R/H — 不该被弹掉(R 永远在栈底,H 在 R 之上)
  // dead/disconnected status + thread 未完结 = 重启 / 进程死了
  if (inst.status === 'dead' || inst.status === 'disconnected') {
    return { suspicious: false, label: `R/H 实例 ${inst.status}(mate 重启遗留,栈帧将 lazy resurrect)` };
  }

  // 其它情况
  return { suspicious: true, label: `R/H 实例 ${inst.status} 但不在栈上 — 可疑` };
}

main();
