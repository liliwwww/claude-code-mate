// Reads `roles/*.md` files, parses frontmatter via gray-matter, exposes lookup.
// Phase 5 will add chokidar hot-reload; Phase 1 just does a one-shot load.

const fs = require('node:fs');
const path = require('node:path');
const matter = require('gray-matter');
const config = require('../config');

const REQUIRED_FIELDS = ['name', 'type', 'parallelism_limit'];
// [需求@2026-06-12] 加 'advisor' type 给 mateBot — 它是 mate self-talk 角色,
//   不参与 R/H/B/C 业务流转,只在 System project 的 mate-self 线索里跟 user 对话。
const ALLOWED_TYPES = ['orchestrator', 'requirements', 'executor', 'validator', 'advisor'];

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
      for (const r of REQUIRED_FIELDS) {
        if (!(r in fm)) {
          console.warn(`[roles] ${file}: missing required frontmatter field "${r}", skipping`);
          continue;
        }
      }
      if (!ALLOWED_TYPES.includes(fm.type)) {
        console.warn(`[roles] ${file}: invalid type "${fm.type}", skipping`);
        continue;
      }
      const def = {
        name: fm.name,
        type: fm.type,
        parallelismLimit: fm.parallelism_limit,
        isCentral: !!fm.is_central,
        sessionTtlHours: fm.session_ttl_hours ?? config.defaultSessionTtlHours,
        displayColor: fm.display_color || '#ccc',
        allowedTools: fm.allowed_tools || [],
        allowRules: fm.allow_rules || [],
        permissionMode: fm.permission_mode || 'dontAsk',
        skillCommand: fm.skill_command || fm.name,
        peerVisibility: fm.peer_visibility || [],
        body: parsed.content.trim(),
        sourcePath: full,
      };
      this.roles.set(def.name, def);
    }

    // Validate exactly one central role
    const centrals = [...this.roles.values()].filter((r) => r.isCentral);
    if (centrals.length === 0) {
      console.warn('[roles] no role marked is_central: true');
    } else if (centrals.length > 1) {
      console.warn(`[roles] multiple central roles: ${centrals.map((r) => r.name).join(', ')}`);
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
