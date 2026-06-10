// [需求@2026-06-10] 极简测试框架(零依赖)
//   提供 describe/it/expect 三个原语。
//   通过 _framework.runAll() 跑完所有注册的测试,产 pass/fail 汇总。
//
// 设计原则:
//   - 测试文件 require('./_framework') 拿 { describe, it, expect },注册测试
//   - 注册不立刻执行;runner 统一 runAll()
//   - it 回调可以是 async
//   - 失败抛 AssertionError(普通 Error 即可),框架捕获并报告

const tests = [];
let currentSuite = '';
let skipNext = false;

function describe(name, fn) {
  const prev = currentSuite;
  currentSuite = prev ? `${prev} > ${name}` : name;
  fn();
  currentSuite = prev;
}

function it(name, fn) {
  tests.push({
    suite: currentSuite,
    name,
    fn,
    skip: skipNext,
  });
  skipNext = false;
}
it.skip = (name, fn) => { skipNext = true; it(name, fn); };

function fail(msg) { throw new Error(msg); }

function expect(actual) {
  const show = (v) => {
    if (typeof v === 'string') return JSON.stringify(v);
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    try { return JSON.stringify(v); } catch { return String(v); }
  };

  return {
    toBe(expected) {
      if (actual !== expected) fail(`expected ${show(expected)}, got ${show(actual)}`);
    },
    toEqual(expected) {
      const a = JSON.stringify(actual);
      const b = JSON.stringify(expected);
      if (a !== b) fail(`deep-eq expected ${b}, got ${a}`);
    },
    toContain(needle) {
      if (typeof actual === 'string') {
        if (!actual.includes(needle)) fail(`expected string to contain ${show(needle)}; got ${show(actual.slice(0, 200))}`);
      } else if (Array.isArray(actual)) {
        if (!actual.some((x) => JSON.stringify(x) === JSON.stringify(needle))) {
          fail(`expected array to contain ${show(needle)}`);
        }
      } else {
        fail(`toContain requires string or array; got ${typeof actual}`);
      }
    },
    toMatch(regex) {
      if (!regex.test(String(actual))) fail(`expected to match ${regex}; got ${show(actual)}`);
    },
    toBeTruthy() { if (!actual) fail(`expected truthy; got ${show(actual)}`); },
    toBeFalsy() { if (actual) fail(`expected falsy; got ${show(actual)}`); },
    toBeNull() { if (actual !== null) fail(`expected null; got ${show(actual)}`); },
    toBeUndefined() { if (actual !== undefined) fail(`expected undefined; got ${show(actual)}`); },
    toBeGreaterThan(n) { if (!(actual > n)) fail(`expected > ${n}; got ${show(actual)}`); },
    toBeGreaterThanOrEqual(n) { if (!(actual >= n)) fail(`expected >= ${n}; got ${show(actual)}`); },
    toHaveLength(n) {
      if (!actual || actual.length !== n) fail(`expected length ${n}; got length ${actual?.length} (${show(actual)})`);
    },
    toThrow(matcher) {
      if (typeof actual !== 'function') fail('toThrow expects a function');
      let err;
      try { actual(); } catch (e) { err = e; }
      if (!err) fail('expected function to throw, but it did not');
      if (matcher instanceof RegExp && !matcher.test(err.message)) {
        fail(`expected error matching ${matcher}; got ${show(err.message)}`);
      }
    },
  };
}

async function runAll({ filter, label } = {}) {
  const filtered = filter ? tests.filter((t) => (t.suite + ' > ' + t.name).includes(filter)) : tests;
  if (label) console.log(`\n=== ${label} (${filtered.length} tests) ===`);

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures = [];
  let lastSuite = '';

  for (const t of filtered) {
    if (t.suite !== lastSuite) {
      console.log(`\n${t.suite}`);
      lastSuite = t.suite;
    }
    if (t.skip) {
      skipped++;
      console.log(`  - ${t.name}  (skipped)`);
      continue;
    }
    const start = Date.now();
    try {
      await t.fn();
      passed++;
      console.log(`  ✓ ${t.name}  (${Date.now() - start}ms)`);
    } catch (e) {
      failed++;
      const dur = Date.now() - start;
      failures.push({ suite: t.suite, name: t.name, error: e });
      console.log(`  ✗ ${t.name}  (${dur}ms)`);
      const msg = (e?.stack || e?.message || String(e)).split('\n').slice(0, 5).join('\n');
      console.log(`    ${msg.replace(/\n/g, '\n    ')}`);
    }
  }

  return { passed, failed, skipped, total: filtered.length, failures };
}

function clearTests() { tests.length = 0; }

module.exports = { describe, it, expect, runAll, clearTests };
