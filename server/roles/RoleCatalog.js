// ============================================================================
// MODULE CONTRACT(架构 SSOT:docs/architecture.md §3 §4 §6)
// ----------------------------------------------------------------------------
// 层:L1 Domain Stores
// 责任:`roles/*.md` 解析 + frontmatter 校验 + 角色定义查询
// 公共 API:load / list / get(name) / central
// 允许依赖:config / fs / gray-matter
// 禁止:
//   - 持久化(roles/*.md 即真理,SQLite 不存角色)
//   - 动态创建 / 修改角色定义(只读)
//   - 在别处 hardcode 角色名(本模块以外用 catalog.get / list)
// ============================================================================
//
// Reads `roles/*.md` files, parses frontmatter via gray-matter, exposes lookup.
// Phase 5 will add chokidar hot-reload; Phase 1 just does a one-shot load.

const fs = require('node:fs');
const path = require('node:path');
const matter = require('gray-matter');
const config = require('../config');
const log = require('../logger');
const MOD = 'RoleCatalog';

// [arch-debt §7 ✅ 2026-06-13] role frontmatter schema
//   每个字段:type / required / 范围(若适用)/ 默认值
//   - 已知字段类型不对 → warn,字段不进 def(沿用默认)
//   - 未知字段(schema 里没有的)→ warn(silent ignore 不再)
//   - required 缺失 → 整 role skip(原行为)
const ROLE_SCHEMA = {
  // [需求@2026-06-12] 'advisor' type 给 mateBot — 不参与 R/H/B/C 业务流转,
  //   只在 System project 的 mate-self 线索里跟 user 对话。
  name:              { type: 'string', required: true },
  type:              { type: 'string', required: true, enum: ['orchestrator', 'requirements', 'executor', 'validator', 'advisor'] },
  parallelism_limit: { type: 'integer', required: true, min: 1, max: 50 },
  is_central:        { type: 'boolean', default: false },
  session_ttl_hours: { type: 'number', min: 0, max: 8760, default: null },  // null = 用 config.defaultSessionTtlHours;0 = 永不过期;max 8760 = 1 年
  display_color:     { type: 'string', default: '#ccc' },
  allowed_tools:     { type: 'array', default: [] },
  allow_rules:       { type: 'array', default: [] },
  permission_mode:   { type: 'string', default: 'dontAsk', enum: ['dontAsk', 'ask', 'denyAll'] },
  skill_command:     { type: 'string', default: null },  // null = fallback to name
  peer_visibility:   { type: 'array', default: [] },
  // [需求@2026-06-15] 每个 role 独立指定 claude model;null = 跟 claude code 默认(usually Opus)
  //   合法 ID 见 https://docs.anthropic.com — 当前用得到的:
  //   claude-opus-4-8 / claude-opus-4-7 / claude-sonnet-4-6 / claude-haiku-4-5 / claude-fable-5
  model:             { type: 'string', default: null },
};

const REQUIRED_FIELDS = Object.entries(ROLE_SCHEMA).filter(([, s]) => s.required).map(([k]) => k);

function validateField(file, key, value, schema) {
  // type check
  if (schema.type === 'integer' && !(Number.isInteger(value))) {
    log.warn({ module: MOD, event: 'invalid_field_type', file, field: key, expected: 'integer', got: typeof value, value });
    return { ok: false };
  }
  if (schema.type === 'number' && typeof value !== 'number') {
    log.warn({ module: MOD, event: 'invalid_field_type', file, field: key, expected: 'number', got: typeof value });
    return { ok: false };
  }
  if (schema.type === 'string' && typeof value !== 'string') {
    log.warn({ module: MOD, event: 'invalid_field_type', file, field: key, expected: 'string', got: typeof value });
    return { ok: false };
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') {
    log.warn({ module: MOD, event: 'invalid_field_type', file, field: key, expected: 'boolean', got: typeof value });
    return { ok: false };
  }
  if (schema.type === 'array' && !Array.isArray(value)) {
    log.warn({ module: MOD, event: 'invalid_field_type', file, field: key, expected: 'array', got: typeof value });
    return { ok: false };
  }
  // enum
  if (schema.enum && !schema.enum.includes(value)) {
    log.warn({ module: MOD, event: 'invalid_field_enum', file, field: key, value, allowed: schema.enum });
    return { ok: false };
  }
  // range
  if (schema.min != null && value < schema.min) {
    log.warn({ module: MOD, event: 'invalid_field_range', file, field: key, value, min: schema.min, direction: 'below' });
    return { ok: false };
  }
  if (schema.max != null && value > schema.max) {
    log.warn({ module: MOD, event: 'invalid_field_range', file, field: key, value, max: schema.max, direction: 'above' });
    return { ok: false };
  }
  return { ok: true };
}

class RoleCatalog {
  constructor() {
    this.roles = new Map(); // name -> RoleDefinition
  }

  load() {
    this.roles.clear();
    const dir = config.paths.rolesDir;
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const full = path.join(dir, file);
      const raw = fs.readFileSync(full, 'utf8');
      const parsed = matter(raw);
      const fm = parsed.data || {};

      // 1) required 字段检查 — 缺失 → 整 role skip
      let missing = false;
      for (const r of REQUIRED_FIELDS) {
        if (!(r in fm)) {
          log.warn({ module: MOD, event: 'missing_required_field', file, field: r, action: 'skip_role' });
          missing = true;
          break;
        }
      }
      if (missing) continue;

      // 2) 未知字段警告(schema 里没有的)
      for (const k of Object.keys(fm)) {
        if (!(k in ROLE_SCHEMA)) {
          log.warn({ module: MOD, event: 'unknown_frontmatter_field', file, field: k, note: 'check_spelling_or_update_ROLE_SCHEMA' });
        }
      }

      // 3) 已知字段类型 + 范围校验
      const validated = {};
      for (const [k, schema] of Object.entries(ROLE_SCHEMA)) {
        if (k in fm) {
          const res = validateField(file, k, fm[k], schema);
          if (res.ok) validated[k] = fm[k];
        }
      }

      // required 已通过,直接 throw 不该再发生 — 但加 defensive 检查
      if (!validated.name || !validated.type || validated.parallelism_limit == null) {
        log.warn({ module: MOD, event: 'required_field_invalid', file, action: 'skip_role' });
        continue;
      }

      const def = {
        name: validated.name,
        type: validated.type,
        parallelismLimit: validated.parallelism_limit,
        isCentral: validated.is_central ?? ROLE_SCHEMA.is_central.default,
        sessionTtlHours: validated.session_ttl_hours ?? config.defaultSessionTtlHours,
        displayColor: validated.display_color ?? ROLE_SCHEMA.display_color.default,
        allowedTools: validated.allowed_tools ?? ROLE_SCHEMA.allowed_tools.default,
        allowRules: validated.allow_rules ?? ROLE_SCHEMA.allow_rules.default,
        permissionMode: validated.permission_mode ?? ROLE_SCHEMA.permission_mode.default,
        skillCommand: validated.skill_command ?? validated.name,
        peerVisibility: validated.peer_visibility ?? ROLE_SCHEMA.peer_visibility.default,
        // [需求@2026-06-15] role 级 model 覆盖;null 时不传 --model,跟 claude 默认
        model: validated.model ?? null,
        body: parsed.content.trim(),
        sourcePath: full,
      };
      this.roles.set(def.name, def);
    }

    // Validate exactly one central role
    const centrals = [...this.roles.values()].filter((r) => r.isCentral);
    if (centrals.length === 0) {
      log.warn({ module: MOD, event: 'no_central_role' });
    } else if (centrals.length > 1) {
      log.warn({ module: MOD, event: 'multiple_central_roles', roles: centrals.map((r) => r.name) });
    }
  }

  list() {
    return [...this.roles.values()];
  }
  get(name) {
    return this.roles.get(name);
  }
  central() {
    return [...this.roles.values()].find((r) => r.isCentral);
  }
}

module.exports = new RoleCatalog();
// 供单测 import
module.exports.ROLE_SCHEMA = ROLE_SCHEMA;
module.exports.validateField = validateField;
