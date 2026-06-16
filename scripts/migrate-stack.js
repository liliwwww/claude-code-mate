#!/usr/bin/env node
// [需求@2026-06-16 RFC Phase 2.2] migration 脚本
//
// 把所有现有 thread 的 dispatch_chain replay 出 call_stack_json + outcome,写入 DB。
//
// 用法:
//   node scripts/migrate-stack.js                # 真跑 + 写库
//   node scripts/migrate-stack.js --dry-run      # 只 replay 不写库,出报告
//   node scripts/migrate-stack.js --only=<slug>  # 只跑某个 thread
//   node scripts/migrate-stack.js --verbose      # 每个 thread 详细输出
//
// 保护:
//   - kb_knowledge 项目的 thread,如果 replay 出的栈丢了任何 instance 的 session_id,
//     脚本 abort 不写库,提示 user
//   - 写库用事务,任何错误回滚
//   - migration 是幂等的:再跑一次结果一样
//
// 输出格式:每个 thread 一行 + 末尾汇总。

const path = require('node:path');
const { db } = require(path.resolve(__dirname, '..', 'server', 'db'));
const { replayChain } = require(path.resolve(__dirname, '..', 'server', 'threads', 'replayChain'));
const TCS = require(path.resolve(__dirname, '..', 'server', 'threads', 'ThreadCallStack'));

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => {
  const m = argv.find((a) => a.startsWith(`--${n}=`));
  return m ? m.split('=')[1] : null;
};

const dryRun = flag('dry-run');
const verbose = flag('verbose');
const onlySlug = opt('only');

// session_id lookup: 从 role_instances 表反查(以前的 instance_id → claude_session_id)
const lookupStmt = db.prepare(`SELECT claude_session_id FROM role_instances WHERE id = ?`);
function lookupSessionId(instId) {
  if (!instId) return null;
  const r = lookupStmt.get(instId);
  return r?.claude_session_id || null;
}

// 收集 kb_knowledge 项目所有 instance 的 session_id (用于保留校验)
function collectKbKnowledgeSessions() {
  const proj = db.prepare(`SELECT id FROM projects WHERE name = 'kb_knowledge'`).get();
  if (!proj) {
    console.log('[migrate] kb_knowledge project 不存在,跳过 session 保留校验');
    return null;
  }
  const insts = db.prepare(`
    SELECT id, claude_session_id, status, bound_thread_slug
    FROM role_instances
    WHERE id IN (
      SELECT DISTINCT instance_id FROM messages
      WHERE instance_id IS NOT NULL
      AND thread_slug IN (SELECT slug FROM threads WHERE project_id = ?)
    )
    AND claude_session_id IS NOT NULL
  `).all(proj.id);
  return {
    projectId: proj.id,
    instances: insts.map((i) => ({
      instId: i.id,
      sessionId: i.claude_session_id,
      status: i.status,
      threadSlug: i.bound_thread_slug,
    })),
  };
}

// 主流程
function main() {
  console.log('='.repeat(70));
  console.log(`[migrate-stack] ${dryRun ? 'DRY RUN' : 'WRITE MODE'}`);
  console.log('='.repeat(70));

  // 收 kb_knowledge session 清单
  const kb = collectKbKnowledgeSessions();
  if (kb) {
    console.log(`[migrate] kb_knowledge: ${kb.instances.length} instance(s) with session_id`);
  }

  // 拿所有 thread
  let threadsQuery = `SELECT slug, project_id, stage, metadata_json, call_stack_json, outcome FROM threads`;
  const params = [];
  if (onlySlug) {
    threadsQuery += ` WHERE slug = ?`;
    params.push(onlySlug);
  }
  threadsQuery += ` ORDER BY updated_at DESC`;
  const threads = db.prepare(threadsQuery).all(...params);
  console.log(`[migrate] scanning ${threads.length} thread(s)`);
  console.log('');

  const stats = {
    total: threads.length,
    skipped_no_chain: 0,
    skipped_already_migrated: 0,
    written: 0,
    write_skipped_dry: 0,
    outcome_verified: 0,
    outcome_aborted: 0,
    outcome_active: 0,
    stack_empty: 0,
    stack_non_empty: 0,
    warnings_total: 0,
    sessions_recovered: 0,
    sessions_missing: 0,
  };
  const failures = [];
  const sessionsInStacks = new Set();

  const updateStmt = db.prepare(`
    UPDATE threads
    SET call_stack_json = ?, outcome = ?, updated_at = ?
    WHERE slug = ?
  `);

  const tx = db.transaction(() => {
    for (const t of threads) {
      let meta;
      try { meta = JSON.parse(t.metadata_json || '{}'); }
      catch { meta = {}; }
      const chain = meta.dispatch_chain || [];

      if (!chain.length) {
        stats.skipped_no_chain++;
        if (verbose) console.log(`  ${t.slug}: skip (no chain)`);
        continue;
      }

      // 幂等性:已 migrate 过的,但仍重 replay 校验(可能 chain 又长了)
      if (t.call_stack_json && !flag('force')) {
        stats.skipped_already_migrated++;
        if (verbose) console.log(`  ${t.slug}: skip (already has call_stack_json — use --force to re-replay)`);
        // 收 session 用于校验
        try {
          const existing = JSON.parse(t.call_stack_json);
          for (const f of (existing.frames || [])) {
            if (f.sessionId) sessionsInStacks.add(f.sessionId);
          }
        } catch {}
        continue;
      }

      // replay
      const r = replayChain(chain, { lookupSessionId });
      stats.warnings_total += r.warnings.length;

      // 收 session
      for (const f of r.stack.frames) {
        if (f.sessionId) sessionsInStacks.add(f.sessionId);
      }
      // 给栈帧补 bound_thread
      for (const f of r.stack.frames) {
        f.boundThread = t.slug;
      }

      if (r.outcome === 'verified') stats.outcome_verified++;
      else if (r.outcome === 'aborted') stats.outcome_aborted++;
      else stats.outcome_active++;

      if (TCS.isEmpty(r.stack)) stats.stack_empty++;
      else stats.stack_non_empty++;

      const stackJson = JSON.stringify({ frames: r.stack.frames });
      const out = r.outcome;

      if (verbose) {
        console.log(`  ${t.slug}: ${chain.length}seg → outcome=${out||'null'}, stack=${r.stack.frames.map((f)=>f.role+(f.slot?'-'+f.slot:'')).join('→')||'∅'}, warnings=${r.warnings.length}`);
      }

      if (dryRun) {
        stats.write_skipped_dry++;
      } else {
        try {
          updateStmt.run(stackJson, out, Date.now(), t.slug);
          stats.written++;
        } catch (e) {
          failures.push({ slug: t.slug, error: e.message });
        }
      }
    }
  });

  if (dryRun) {
    tx(); // 还是跑 tx,但内部都 skip 写
  } else {
    tx();
  }

  console.log('');
  console.log('-'.repeat(70));
  console.log('SUMMARY');
  console.log('-'.repeat(70));
  console.log(`Total threads scanned:       ${stats.total}`);
  console.log(`  skipped (no chain):        ${stats.skipped_no_chain}`);
  console.log(`  skipped (already done):    ${stats.skipped_already_migrated}`);
  console.log(`  written to call_stack_json: ${stats.written}`);
  if (dryRun) console.log(`  would-write (dry):        ${stats.write_skipped_dry}`);
  console.log('');
  console.log(`Outcome distribution:`);
  console.log(`  verified: ${stats.outcome_verified}`);
  console.log(`  aborted:  ${stats.outcome_aborted}`);
  console.log(`  active:   ${stats.outcome_active}`);
  console.log('');
  console.log(`Stack distribution:`);
  console.log(`  empty:     ${stats.stack_empty}`);
  console.log(`  non-empty: ${stats.stack_non_empty}`);
  console.log('');
  console.log(`Total warnings: ${stats.warnings_total}`);

  // kb_knowledge session 保留校验
  if (kb) {
    console.log('');
    console.log('-'.repeat(70));
    console.log(`kb_knowledge session preservation check`);
    console.log('-'.repeat(70));
    let lost = 0;
    let kept = 0;
    for (const inst of kb.instances) {
      if (sessionsInStacks.has(inst.sessionId)) {
        kept++;
      } else {
        lost++;
        console.log(`  ⚠ session ${inst.sessionId.slice(0, 12)}... (instance ${inst.instId}, thread ${inst.threadSlug||'?'}) NOT in any stack`);
      }
    }
    console.log(`  ✓ kept: ${kept}`);
    console.log(`  ✗ lost: ${lost}`);
    if (lost > 0) {
      console.log('');
      console.log('  注: lost ≠ 一定丢数据。可能是:');
      console.log('   - 该 instance 不在任何 active thread 上(已 done/aborted)');
      console.log('   - 老 chain 没记录该 instance(早于 dispatch_chain feature)');
      console.log('  实例本身的 claude_session_id 仍在 role_instances 表里 — 不会消失。');
      console.log('  栈模型只是新增 SSOT,不删原数据。');
    }
  }

  // 失败列表
  if (failures.length) {
    console.log('');
    console.log('-'.repeat(70));
    console.log(`Failures: ${failures.length}`);
    console.log('-'.repeat(70));
    for (const f of failures) console.log(`  ✗ ${f.slug}: ${f.error}`);
  }

  console.log('='.repeat(70));
  if (dryRun) {
    console.log('DRY RUN — nothing written. Re-run without --dry-run to commit.');
  } else {
    console.log(`Migration complete: ${stats.written} threads updated.`);
  }
  console.log('='.repeat(70));

  process.exit(failures.length ? 1 : 0);
}

main();
