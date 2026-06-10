---
name: Bug 报告
about: 出错 / 行为跟预期不一致
title: "[BUG] "
labels: bug
---

## 现象

简洁描述出了什么问题。

## 复现步骤

1. ...
2. ...
3. ...

## 期望行为

期望应该发生什么。

## 实际行为

实际发生了什么。能附图 / 日志最好。

## 环境

- 操作系统:[Win 10 / Win 11 ...]
- Node 版本:`node --version`
- Claude Code CLI 版本:`claude --version`
- Mate commit / version:`git rev-parse HEAD` 或 `CHANGELOG.md` 里写的版本
- 是否走代理:[是 / 否]

## 日志

`data/server.log` 相关片段(脱敏后)。

## 数据库状态(可选)

```powershell
node -e "const db=new (require('better-sqlite3'))('data/mate.sqlite',{readonly:true}); console.log('projects:', db.prepare('SELECT COUNT(*) FROM projects').get()); console.log('threads:', db.prepare('SELECT COUNT(*) FROM threads').get()); console.log('instances by status:', db.prepare('SELECT status, COUNT(*) FROM role_instances GROUP BY status').all());"
```

## 备注

任何其它你觉得有用的信息。
