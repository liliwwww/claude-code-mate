// ============================================================================
// MODULE CONTRACT — i18n runtime
// ----------------------------------------------------------------------------
// 层:L6 Frontend / 组件
// 责任:翻译 lookup、占位符注入、language toggle 持久化、DOM 重渲染、订阅。
// 公共 API:window.MateI18n
//   init() / t(key, params) / setLang(lang) / getLang() / applyDom() / onChange(handler)
// 允许依赖:window.MateMessages, localStorage, document
// 禁止:
//   - 远程加载语言包(本地编译)
//   - 改业务 state(只翻译)
//   - 与具体 component 紧耦合(component 自己订阅 onChange)
// ============================================================================
//
// 设计:
//   - 默认 lang 优先级: localStorage('mate.lang') > navigator.language > 'zh'
//   - missing key 兜底 = 返回 key 本身(方便定位)
//   - DOM 翻译扫描:
//       [data-i18n="key"]          → textContent = t(key)
//       [data-i18n-attr-title="k"] → setAttribute('title', t(k))
//       [data-i18n-attr-placeholder="k"] → setAttribute('placeholder', t(k))
//       [data-i18n-attr-aria-label="k"]  → setAttribute('aria-label', t(k))
//       [data-i18n-html="k"]       → innerHTML = t(k)   (用于含 <strong> 等)
//   - setLang() 后自动 applyDom() 并触发 onChange listener

(function () {
  if (window.MateI18n) return;

  const LS_KEY = 'mate.lang';
  const SUPPORTED = ['zh', 'en'];
  const FALLBACK_LANG = 'zh';

  const state = {
    lang: FALLBACK_LANG,
    listeners: new Set(),
  };

  function detectInitialLang() {
    const saved = (() => {
      try { return localStorage.getItem(LS_KEY); } catch { return null; }
    })();
    if (saved && SUPPORTED.includes(saved)) return saved;
    const nav = (navigator.language || navigator.userLanguage || '').toLowerCase();
    if (nav.startsWith('zh')) return 'zh';
    if (nav.startsWith('en')) return 'en';
    return FALLBACK_LANG;
  }

  function dict() {
    const m = window.MateMessages || {};
    return m[state.lang] || m[FALLBACK_LANG] || {};
  }

  function t(key, params) {
    if (typeof key !== 'string') return '';
    const table = dict();
    let raw = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
    if (raw == null) {
      // fallback chain: current → zh → key
      const fb = (window.MateMessages || {})[FALLBACK_LANG] || {};
      raw = Object.prototype.hasOwnProperty.call(fb, key) ? fb[key] : key;
    }
    if (typeof raw !== 'string') return String(raw);
    if (!params) return raw;
    return raw.replace(/\{(\w+)\}/g, (full, name) => {
      if (Object.prototype.hasOwnProperty.call(params, name)) {
        const v = params[name];
        return v == null ? '' : String(v);
      }
      return full;
    });
  }

  function applyDom(root) {
    const scope = root || document;
    // textContent
    scope.querySelectorAll('[data-i18n]').forEach((node) => {
      const key = node.getAttribute('data-i18n');
      if (!key) return;
      node.textContent = t(key);
    });
    // innerHTML (small set; only for keys whose value intentionally contains HTML)
    scope.querySelectorAll('[data-i18n-html]').forEach((node) => {
      const key = node.getAttribute('data-i18n-html');
      if (!key) return;
      node.innerHTML = t(key);
    });
    // attribute translations: data-i18n-attr-<attrName>="key"
    //   e.g. data-i18n-attr-title, data-i18n-attr-placeholder, data-i18n-attr-aria-label
    scope.querySelectorAll('*').forEach((node) => {
      for (const attr of Array.from(node.attributes)) {
        if (!attr.name.startsWith('data-i18n-attr-')) continue;
        const targetAttr = attr.name.slice('data-i18n-attr-'.length);
        if (!targetAttr) continue;
        node.setAttribute(targetAttr, t(attr.value));
      }
    });
    // update <html lang="...">
    document.documentElement.setAttribute('lang', state.lang === 'zh' ? 'zh-CN' : 'en');

    // update <title>: prefer data-i18n on <title>, else use a known mapping
    const titleEl = document.querySelector('title');
    if (titleEl) {
      const k = titleEl.getAttribute('data-i18n');
      if (k) titleEl.textContent = t(k);
    }
  }

  function setLang(lang) {
    if (!SUPPORTED.includes(lang)) return;
    if (state.lang === lang) return;
    state.lang = lang;
    try { localStorage.setItem(LS_KEY, lang); } catch {}
    applyDom();
    for (const h of state.listeners) {
      try { h(lang); } catch (e) { console.warn('[i18n] onChange handler error:', e); }
    }
  }

  function getLang() {
    return state.lang;
  }

  function onChange(handler) {
    if (typeof handler !== 'function') return () => {};
    state.listeners.add(handler);
    return () => state.listeners.delete(handler);
  }

  function init() {
    state.lang = detectInitialLang();
    document.documentElement.setAttribute('lang', state.lang === 'zh' ? 'zh-CN' : 'en');
    // run applyDom once DOM is parseable enough to query;
    // safe to call sync because i18n.js loads after the HTML body content is parsed by the time
    // <script> at end of body executes — but DOMContentLoaded is the cleanest signal.
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => applyDom(), { once: true });
    } else {
      applyDom();
    }
  }

  window.MateI18n = { init, t, setLang, getLang, applyDom, onChange };

  // Auto-init at module load so t() works immediately for components.
  init();
})();
