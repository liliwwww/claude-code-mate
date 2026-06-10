#!/usr/bin/env node
// [需求@2026-06-10] 测试 runner
//   - node tests/runner.js                  # 只跑单测(快,免费)
//   - node tests/runner.js --integration    # 单测 + 全部集成(慢,~$3)
//   - node tests/runner.js --integration --only=03   # 只跑 03_multi_thread
//   - node tests/runner.js --only=marker    # 跑 marker 相关的所有测试

const fs = require('node:fs');
const path = require('node:path');
const { runAll, clearTests } = require('./_framework');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const m = argv.find((a) => a.startsWith(`--${name}=`));
  return m ? m.split('=')[1] : null;
};

const integration = flag('integration');
const onlyFilter = opt('only');

function loadDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js') && !f.startsWith('_'))
    .map((f) => path.join(dir, f))
    .sort();
}

(async () => {
  const allFailures = [];
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;

  // ---------- Unit tests ----------
  clearTests();
  const unitFiles = loadDir(path.join(__dirname, 'unit'));
  for (const f of unitFiles) require(f);
  const unit = await runAll({ filter: onlyFilter, label: 'UNIT TESTS' });
  totalPassed += unit.passed;
  totalFailed += unit.failed;
  totalSkipped += unit.skipped;
  allFailures.push(...unit.failures);

  // ---------- Integration tests ----------
  if (integration) {
    console.log(`\n${'='.repeat(60)}`);
    console.log('INTEGRATION TESTS — requires `node server/index.js` running');
    console.log('Estimated cost: $1-3 in claude API charges (depends on opt-ins)');
    console.log(`${'='.repeat(60)}`);

    clearTests();
    const intFiles = loadDir(path.join(__dirname, 'integration'));
    for (const f of intFiles) {
      if (onlyFilter && !path.basename(f).includes(onlyFilter)) continue;
      require(f);
    }
    const integ = await runAll({ filter: null, label: 'INTEGRATION TESTS' });
    totalPassed += integ.passed;
    totalFailed += integ.failed;
    totalSkipped += integ.skipped;
    allFailures.push(...integ.failures);
  } else {
    console.log(`\n(integration tests skipped — pass --integration to enable)`);
  }

  // ---------- Summary ----------
  console.log(`\n${'='.repeat(60)}`);
  console.log(`SUMMARY: ${totalPassed} passed · ${totalFailed} failed · ${totalSkipped} skipped`);
  if (totalFailed > 0) {
    console.log(`\nFailures:`);
    for (const f of allFailures) {
      console.log(`  ✗ ${f.suite} > ${f.name}`);
      console.log(`    ${(f.error?.message || String(f.error)).split('\n')[0]}`);
    }
  }
  console.log(`${'='.repeat(60)}`);

  process.exit(totalFailed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('runner crashed:', e);
  process.exit(2);
});
