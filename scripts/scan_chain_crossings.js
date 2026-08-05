#!/usr/bin/env node
// 全库扫描 chain 走串 — 各 thread chain 里 reason/summary 引用别的 thread slug
// 输出:所有交叉 seg,标记时间,方便判断是修复前的历史 vs 修复后新增
//
// 用法:
//   node scripts/scan_chain_crossings.js                    # 全部
//   node scripts/scan_chain_crossings.js --since=2026-07-28  # 只看时间之后

const Database = require('better-sqlite3');
const path = require('path');

const args = process.argv.slice(2);
const sinceArg = args.find(a => a.startsWith('--since='));
const sinceMs = sinceArg ? new Date(sinceArg.slice(8)).getTime() : 0;

const db = new Database(path.join(__dirname, '..', 'data', 'mate.sqlite'), { readonly: true });
const rows = db.prepare('SELECT slug, project_id, metadata_json FROM threads').all();

const crossings = [];
for (const r of rows) {
  let chain;
  try {
    chain = JSON.parse(r.metadata_json).dispatch_chain || [];
  } catch { continue; }
  chain.forEach((c, i) => {
    const text = (c.reason || c.summary || '');
    // 匹配 t-mxxxxxxx-xxxx 格式
    const slugRefs = text.match(/t-m[a-z0-9]{7}-[a-z0-9]{4}/g) || [];
    for (const s of slugRefs) {
      if (s !== r.slug) {
        crossings.push({
          host: r.slug,
          project: r.project_id,
          idx: i,
          ts: c.ts,
          kind: c.kind,
          from: c.fromRole,
          to: c.toRole || c.toDisplayName || '',
          otherSlug: s,
          preview: text.slice(0, 100).replace(/\n/g, ' '),
        });
        break;
      }
    }
  });
}

crossings.sort((a, b) => a.ts - b.ts);

const filtered = sinceMs ? crossings.filter(c => c.ts >= sinceMs) : crossings;

console.log(`=== chain crossings scan (${sinceArg ? sinceArg : 'ALL time'}) ===`);
console.log(`total: ${filtered.length} crossings across ${new Set(filtered.map(c => c.host)).size} threads`);
console.log();
if (filtered.length === 0) {
  console.log('✅ NO CROSSINGS in the queried window.');
  process.exit(0);
}

// group by host
const byHost = {};
for (const c of filtered) {
  if (!byHost[c.host]) byHost[c.host] = [];
  byHost[c.host].push(c);
}
for (const [host, list] of Object.entries(byHost)) {
  console.log(`--- ${host} (project ${list[0].project}, ${list.length} crossings) ---`);
  list.forEach(c => {
    console.log(`  [${c.idx}] ${new Date(c.ts).toISOString()} ${c.kind} ${c.from}→${c.to}`);
    console.log(`      refs: ${c.otherSlug}`);
    console.log(`      ${c.preview}`);
  });
  console.log();
}

// 汇总:最新走串时间,方便判断"修完之后有没有新增"
const latest = filtered[filtered.length - 1];
console.log(`Latest crossing: ${new Date(latest.ts).toISOString()} in ${latest.host}[${latest.idx}]`);
