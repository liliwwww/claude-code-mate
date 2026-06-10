// [需求@2026-06-10] 集成 01 — 启动与基础健康
//   覆盖:server alive / system endpoint / projects list 含 Default / roles 4 个 / restoreFromDisk 不报错
//   预算:零 claude 调用,纯 REST 读

const { describe, it, expect } = require('../_framework');
const { api, requireServer } = require('../_helpers');

describe('01 — startup', () => {
  it('server responds on /api/system with required fields', async () => {
    await requireServer();
    const r = await api('/system');
    expect(r.status).toBe(200);
    expect(r.body.port).toBe(8721);
    expect(r.body.defaultProjectId).toBeTruthy();
    expect(r.body.version).toBeTruthy();
  });

  it('Default project always exists', async () => {
    const r = await api('/projects');
    expect(r.status).toBe(200);
    const def = r.body.find((p) => p.name === 'Default');
    expect(def).toBeTruthy();
    expect(def.root_dir).toBeTruthy();
  });

  it('4 default roles loaded with correct types', async () => {
    const r = await api('/roles');
    expect(r.status).toBe(200);
    const names = r.body.map((x) => x.name).sort();
    expect(names).toEqual(['execB', 'planA-H', 'planA-R', 'testC']);

    const central = r.body.filter((x) => x.isCentral);
    expect(central).toHaveLength(1);
    expect(central[0].name).toBe('planA-H');

    const byType = (t) => r.body.find((x) => x.type === t);
    expect(byType('requirements').name).toBe('planA-R');
    expect(byType('orchestrator').name).toBe('planA-H');
    expect(byType('executor').name).toBe('execB');
    expect(byType('validator').name).toBe('testC');
  });

  it('healthcheck endpoint runs all 4 probes', async () => {
    const r = await api('/system/healthcheck', { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.body.checks).toHaveLength(4);
    const names = r.body.checks.map((c) => c.name);
    expect(names).toContain('claude binary');
    expect(names).toContain('proxy env');
    expect(names).toContain('SQLite writable');
    expect(names).toContain('claude auth + API reach');
  });
});
