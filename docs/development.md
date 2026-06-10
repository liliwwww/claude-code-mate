# 开发指南

## 起步

```powershell
git clone https://github.com/liliwwww/claude-code-mate.git
cd claude-code-mate
nvm use   # 读 .nvmrc -> Node 18
npm install
copy .env.example .env
# 编辑 .env: 至少设 HTTP_PROXY / HTTPS_PROXY
npm start
```

浏览器开 <http://127.0.0.1:8721>。

## 项目模块树

```
server/
├── index.js              入口(Express + WebSocket bootstrap)
├── config.js             .env 加载 + 路径/默认值
├── db.js                 better-sqlite3 + WAL + 迁移
├── messageBus.js         进程内 pub/sub(EventEmitter)
├── spawn/
│   ├── SpawnManager.js   实例池(per-project, per-role)
│   ├── RoleInstance.js   单 claude 子进程封装 + 生命周期
│   └── streamParser.js   NDJSON 容错 + 辅助函数(extractAssistantText 等)
├── roles/
│   └── RoleCatalog.js    roles/*.md 加载 + frontmatter 校验
├── projects/
│   └── ProjectStore.js   projects 表 CRUD + 目录 inspect
└── api/
    ├── http.js           REST endpoints(/api/...)
    └── ws.js             WebSocket fanout
```

## 常用脚本

```powershell
npm start                  # 生产模式启动
npm run dev                # node --watch 自动重启
node probe/01_text_in_stream_out.js     # 跑探针
```

## 调试 claude 协议

如果你怀疑 claude CLI 的 stream-json 输出变了,起最小探针实证:

```js
// probe/dbg.js
const { spawn } = require('child_process');
const c = spawn('claude', ['-p', 'hi', '--output-format', 'stream-json', '--verbose'], {
  env: { ...process.env, HTTP_PROXY: 'http://127.0.0.1:10808', HTTPS_PROXY: 'http://127.0.0.1:10808' },
  windowsHide: true,
});
c.stdout.on('data', (d) => process.stdout.write(d));
c.stderr.on('data', (d) => process.stderr.write(d));
```

跑 `node probe/dbg.js` 就能看到原始 NDJSON。

已有 11 个 probe 脚本覆盖关键场景(stdin schema / resume / partial messages / permission / 进程树 kill 等),见 [stream-json-protocol.md](./stream-json-protocol.md)。

## 数据库

- 文件:`data/mate.sqlite`(gitignored)
- 模式:WAL,`mate.sqlite-wal` + `mate.sqlite-shm` 是 SQLite 自管的辅助文件
- Schema 迁移在 `server/db.js` 启动时自动跑
- 直接看数据:`sqlite3 data/mate.sqlite` 或 `node -e "const db=new (require('better-sqlite3'))('data/mate.sqlite'); console.log(db.prepare('SELECT * FROM projects').all());"`

清空数据(谨慎):
```powershell
Remove-Item data/mate.sqlite*
```

下次 `npm start` 会重建 schema + 创建 Default project。

## 进程管理

mate 启动时 spawn N 个 claude 子进程。如果你 Ctrl+C 杀 mate:

- mate 的 SIGINT handler 会调 `SpawnManager.shutdown()` 优雅 kill 所有子进程
- 但如果 mate 被强杀(`taskkill /F`),claude 子进程会变孤儿
- 兜底:重启 mate,`restoreFromDisk` 把数据库里活着的实例标 disconnected;**旧 claude 进程不会被自动 kill,需手动**:
  ```powershell
  tasklist /FI "imagename eq claude.exe"
  ```

清理孤儿 claude 进程(谨慎,会杀所有 claude;包括你的别的 Claude Code session!):
```powershell
taskkill /F /IM claude.exe
```

## 端口被占

如果 `EADDRINUSE: address already in use 127.0.0.1:8721`:

```powershell
node -e "
const { execSync } = require('child_process');
const out = execSync('netstat -ano -p tcp', {encoding:'utf8'});
for (const line of out.split(/\r?\n/)) {
  const m = line.match(/127\.0\.0\.1:8721\s+\S+\s+LISTENING\s+(\d+)/i);
  if (m) execSync('taskkill /F /T /PID ' + m[1], {stdio:'pipe'});
}
"
```

或改 `.env` 的 `PORT=` 换个端口。

## 测试

目前**没有正式测试框架**(贡献 PR 加 vitest/jest 欢迎)。代替方案:

1. **探针**(`probe/*.js`)是真实集成测试 — 改了 spawn/parser 层就跑一遍
2. **端到端冒烟**:
   ```powershell
   npm start
   # 浏览器开 → 切 project → spawn R → 发消息 → 验证流式 → kill → 重启 → 验证恢复
   ```

## 前端调试

无 build chain,直接改 `public/app.js` 刷浏览器即可。WebSocket 调试:

```js
// 浏览器 console
ws = new WebSocket('ws://127.0.0.1:8721/ws');
ws.onmessage = (e) => console.log('WS:', JSON.parse(e.data));
```

## 贡献

详见 [CONTRIBUTING.md](../CONTRIBUTING.md)。
