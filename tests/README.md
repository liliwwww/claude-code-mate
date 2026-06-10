# Tests

两层结构:**unit**(快,免费)+ **integration**(慢,要钱)。

## 跑测试

### 只跑单测(无需 server,无 claude 调用,几十毫秒)

```powershell
npm test
# 或
node tests/runner.js
```

覆盖:
- `unit/markerDetector.test.js` — `<mate:handoff/>` `<mate:done/>` `<mate:blocked/>` 各种形态 + 边界
- `unit/streamParser.test.js` — NDJSON 跨 chunk / 多事件 / 畸形 / 超大行

### 跑集成测试(需要 server 在 8721 跑,会花钱)

```powershell
# 先确保 server 跑着
node server/index.js

# 另一个终端:
node tests/runner.js --integration
```

**估算成本**:Default 7 个场景全跑约 **$1-3**(claude API 调用)。

| 场景 | 内容 | 预算 |
|---|---|---|
| 01 startup | server boot + roles + healthcheck | $0(纯 REST) |
| 02 lazy spawn | 创建线索 + 单线索往返 | $0.20-0.40 |
| 03 multi-thread | 3 线索并发讨论 + parallelism 验证 | $0.20-0.50 |
| 04 auto handoff | R 自动 handoff 到 H | $0.40-0.80 |
| 05 full state machine | R → H → execB(可能到 verified) | $0.80-2.00 |
| 06 blocked | 模糊需求 → mate:blocked 信号 | $0.20-0.40 |
| 07 restart recovery | kill 实例 → 续上 session via --resume | $0.30-0.60 |

### 只跑某一类

```powershell
# 只跑 marker 相关
node tests/runner.js --only=marker

# 只跑某个集成场景
node tests/runner.js --integration --only=04

# 只跑单测中的 streamParser
node tests/runner.js --only=streamParser
```

## 写新测试

```js
// tests/unit/myNew.test.js
const { describe, it, expect } = require('../_framework');
const M = require('../../server/path/to/module');

describe('module name', () => {
  it('does the thing', () => {
    expect(M.fn(1, 2)).toBe(3);
  });
});
```

集成测试用 `tests/_helpers` 拿到 `api()`/`waitFor()`/`ensureSandboxProject()` 等便利:

```js
const { api, waitFor, ensureSandboxProject } = require('../_helpers');

describe('XX — scenario', () => {
  let projectId;
  it('setup', async () => {
    projectId = (await ensureSandboxProject()).id;
  });
  // ...
});
```

## 关键约束

- **集成测试**全部用 `test-sandbox` project(`data/test-sandbox/` 目录)— **绝不**碰 `Default`,user 自己的数据要保护
- 每个测试 setup 都 `archiveAllSandboxThreads` + `killProjectInstances` 清理上次残留
- cleanup 步骤即使失败也不抛(不污染下一个测试)

## CI(GitHub Actions)

`.github/workflows/ci.yml` 只跑 unit(免费)。Integration 需要 claude CLI + Max 订阅,只能本地跑。
