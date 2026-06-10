// [需求@2026-06-10] 多 project first-class (user Q1 + Q4) — ProjectStore 是
// projects 表的 CRUD 封装。Phase 2A 起 mate 可同时管理多个 sibling project
// (D:\dev\kb_backend, D:\dev\web_gmail, ..., 也包括 mate 自己).

const fs = require('node:fs');
const path = require('node:path');
const { db, stmts } = require('../db');

const ProjectStore = {
  list() {
    return stmts.listProjects.all();
  },

  get(id) {
    return stmts.getProject.get(id) || null;
  },

  getByName(name) {
    return stmts.getProjectByName.get(name) || null;
  },

  /**
   * Create or import a project.
   * - For "import existing", caller passes a rootDir that already exists.
   * - For "new", caller may pass a not-yet-existent rootDir; we won't mkdir
   *   (user should create the directory themselves to confirm intent).
   */
  create({ name, rootDir, settings = {} }) {
    if (!name || typeof name !== 'string') throw new Error('name required');
    if (!rootDir || typeof rootDir !== 'string') throw new Error('rootDir required');
    const absoluteRoot = path.resolve(rootDir);
    if (!fs.existsSync(absoluteRoot)) {
      throw new Error(`rootDir does not exist: ${absoluteRoot}`);
    }
    const stat = fs.statSync(absoluteRoot);
    if (!stat.isDirectory()) {
      throw new Error(`rootDir is not a directory: ${absoluteRoot}`);
    }
    const existing = stmts.getProjectByName.get(name);
    if (existing) throw new Error(`project with name "${name}" already exists`);

    const r = stmts.insertProject.run(name, absoluteRoot, JSON.stringify(settings), Date.now());
    return stmts.getProject.get(r.lastInsertRowid);
  },

  archive(id) {
    const proj = stmts.getProject.get(id);
    if (!proj) throw new Error(`project ${id} not found`);
    if (proj.name === 'Default') throw new Error('Default project cannot be archived');
    stmts.archiveProject.run(Date.now(), id);
    return stmts.getProject.get(id);
  },

  /**
   * For Phase 2A: detect whether a directory looks like a Claude Code project
   * (has .claude/ or git). Used by UI's "scan / import" picker.
   */
  inspectDir(dirPath) {
    const absolute = path.resolve(dirPath);
    if (!fs.existsSync(absolute)) return { exists: false };
    const stat = fs.statSync(absolute);
    if (!stat.isDirectory()) return { exists: true, isDirectory: false };
    const hasClaude = fs.existsSync(path.join(absolute, '.claude'));
    const hasGit = fs.existsSync(path.join(absolute, '.git'));
    return {
      exists: true,
      isDirectory: true,
      absolute,
      hasClaude,
      hasGit,
      hasPackageJson: fs.existsSync(path.join(absolute, 'package.json')),
      hasClaudeMd: fs.existsSync(path.join(absolute, 'CLAUDE.md')),
    };
  },
};

module.exports = ProjectStore;
