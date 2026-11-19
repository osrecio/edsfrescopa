// eslint-disable-next-line import/no-unresolved
import DA_SDK from 'https://da.live/nx/utils/sdk.js';

const DA_ADMIN = 'https://admin.da.live';
const CONCURRENCY = 8;
const MAX_PAGES = 3000;
const SYSTEM_BLOCKS = new Set(['metadata', 'section-metadata', 'library-metadata']);
const CHILD_COMPONENT = /(-item|-row|-cell)$|^card$/;

const $ = (sel) => document.querySelector(sel);
const el = {
  site: $('.bx-site'),
  form: $('.bx-scan'),
  submit: $('.bx-scan button'),
  progress: $('.bx-progress'),
  progressText: $('.bx-progress-text'),
  progressBar: $('.bx-progress-bar span'),
  message: $('.bx-message'),
  empty: $('.bx-empty'),
  results: $('.bx-results'),
  kpis: $('.bx-kpis'),
  alerts: $('.bx-alerts'),
  ranking: $('.bx-ranking'),
  detail: $('.bx-detail'),
  tabs: [...document.querySelectorAll('[data-tab]')],
  panels: [...document.querySelectorAll('[data-panel]')],
  system: $('.bx-system'),
  scanned: $('.bx-scanned'),
  exportBtn: $('.bx-export'),
  search: $('.bx-search'),
  tbody: $('.bx-table tbody'),
};

const state = {
  org: '',
  repo: '',
  token: '',
  pages: [], // { path, blocks: [{ name, variants: [] }] }
  libraryBlocks: [],
  codeExists: {}, // name -> boolean
  selected: '',
  showSystem: false,
  scannedAt: null,
};

const escape = (str) => String(str ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const webPath = (path) => path.replace(/\.html$/, '').replace(/\/index$/, '/');
const editUrl = (path) => `https://da.live/edit#/${state.org}/${state.repo}${path.replace(/\.html$/, '')}`;
const previewUrl = (path) => `https://main--${state.repo}--${state.org}.aem.page${webPath(path)}`;
const storageKey = () => `block-explorer:${state.org}/${state.repo}`;

const authFetch = (url, options = {}) => fetch(url, {
  ...options,
  headers: { ...options.headers, Authorization: `Bearer ${state.token}` },
});

async function runPool(items, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      // eslint-disable-next-line no-await-in-loop
      await worker(queue.shift());
    }
  });
  await Promise.all(runners);
}

function setMessage(text, type = '') {
  el.message.textContent = text;
  el.message.dataset.type = type;
}

function setProgress(text, ratio) {
  el.progress.hidden = ratio === null;
  el.progressText.textContent = text;
  el.progressBar.style.width = `${Math.round((ratio || 0) * 100)}%`;
}

/* ---------- Data gathering ---------- */

async function listFolder(path) {
  const items = [];
  let continuation = '';
  do {
    const headers = continuation ? { 'da-continuation-token': continuation } : {};
    // eslint-disable-next-line no-await-in-loop
    const resp = await authFetch(`${DA_ADMIN}/list/${state.org}/${state.repo}${path}`, { headers });
    if (!resp.ok) throw new Error(`Cannot list ${path || '/'} (${resp.status})`);
    // eslint-disable-next-line no-await-in-loop
    items.push(...await resp.json());
    continuation = resp.headers.get('da-continuation-token') || '';
  } while (continuation);
  return items;
}

async function crawl(scope, excludes) {
  const prefix = `/${state.org}/${state.repo}`;
  const pages = [];
  const folders = [scope === '/' ? '' : scope.replace(/\/$/, '')];
  const isExcluded = (p) => excludes.some((ex) => p === ex || p.startsWith(`${ex}/`));

  while (folders.length && pages.length < MAX_PAGES) {
    const batch = folders.splice(0, CONCURRENCY);
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all(batch.map(listFolder));
    results.flat().forEach((item) => {
      const path = item.path.slice(prefix.length);
      if (isExcluded(path) || item.name.startsWith('.')) return;
      if (!item.ext) folders.push(path);
      else if (item.ext === 'html') pages.push(path);
    });
    setProgress(`Discovering pages… ${pages.length} found`, 0.05);
  }
  return pages.slice(0, MAX_PAGES);
}

function parseBlocks(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('main > div > div[class]')].map((div) => {
    const [name, ...variants] = [...div.classList];
    return { name: name.toLowerCase(), variants: variants.map((v) => v.toLowerCase()) };
  });
}

async function loadLibraryBlocks() {
  try {
    const resp = await fetch('/component-definition.json');
    const json = await resp.json();
    const group = json.groups.find((g) => g.id === 'blocks');
    return group.components.map((c) => c.id).filter((id) => !CHILD_COMPONENT.test(id));
  } catch (e) {
    return [];
  }
}

async function checkCode(names) {
  const result = {};
  await runPool(names, async (name) => {
    try {
      const resp = await fetch(`/blocks/${name}/${name}.js`, { method: 'HEAD' });
      result[name] = resp.ok;
    } catch (e) {
      result[name] = false;
    }
  });
  return result;
}

/* ---------- Aggregation ---------- */

function aggregate() {
  const blocks = new Map();
  state.pages.forEach((page) => {
    page.blocks.forEach(({ name, variants }) => {
      if (!state.showSystem && SYSTEM_BLOCKS.has(name)) return;
      if (!blocks.has(name)) {
        blocks.set(name, {
          name, uses: 0, pages: new Map(), variants: new Map(),
        });
      }
      const b = blocks.get(name);
      b.uses += 1;
      b.pages.set(page.path, (b.pages.get(page.path) || 0) + 1);
      const key = variants.length ? variants.join(' ') : '(default)';
      b.variants.set(key, (b.variants.get(key) || 0) + 1);
    });
  });
  return [...blocks.values()].sort((a, b) => b.pages.size - a.pages.size || b.uses - a.uses);
}

/* ---------- Rendering ---------- */

function renderKpis(blocks) {
  const uses = blocks.reduce((sum, b) => sum + b.uses, 0);
  const variants = blocks.reduce((sum, b) => sum + b.variants.size, 0);
  const avg = state.pages.length ? (uses / state.pages.length).toFixed(1) : '0';
  const kpis = [
    ['Pages scanned', state.pages.length],
    ['Blocks in use', blocks.length],
    ['Block instances', uses],
    ['Variant combos', variants],
    ['Blocks per page', avg],
  ];
  el.kpis.innerHTML = kpis.map(([label, value]) => `
    <div class="bx-kpi"><span class="bx-kpi-value">${escape(value)}</span><span class="bx-kpi-label">${escape(label)}</span></div>
  `).join('');
}

function renderAlerts(blocks) {
  const used = new Set(blocks.map((b) => b.name));
  const missing = blocks
    .filter((b) => !SYSTEM_BLOCKS.has(b.name) && state.codeExists[b.name] === false);
  const unused = state.libraryBlocks.filter((name) => !used.has(name));
  const alerts = [];
  if (missing.length) {
    alerts.push(`<div class="bx-alert bx-alert-error">
      <strong>${missing.length} block${missing.length > 1 ? 's' : ''} without code</strong>
      <span>Used in content but no <code>/blocks/…</code> implementation:</span>
      ${missing.map((b) => `<button type="button" class="bx-chip bx-chip-error" data-block="${escape(b.name)}">${escape(b.name)}</button>`).join('')}
    </div>`);
  }
  if (unused.length) {
    alerts.push(`<div class="bx-alert bx-alert-warn">
      <strong>${unused.length} library block${unused.length > 1 ? 's' : ''} never used</strong>
      <span>Available to authors but not on any scanned page:</span>
      ${unused.map((name) => `<span class="bx-chip">${escape(name)}</span>`).join('')}
    </div>`);
  }
  if (!alerts.length) {
    alerts.push('<div class="bx-alert bx-alert-ok"><strong>All good</strong><span>Every block in content has code, and every library block is in use.</span></div>');
  }
  el.alerts.innerHTML = alerts.join('');
}

function renderRanking(blocks) {
  const max = Math.max(1, ...blocks.map((b) => b.pages.size));
  el.ranking.innerHTML = blocks.map((b) => {
    const pct = Math.max(2, Math.round((b.pages.size / max) * 100));
    const noCode = state.codeExists[b.name] === false && !SYSTEM_BLOCKS.has(b.name);
    return `<li>
      <button type="button" data-block="${escape(b.name)}" aria-pressed="${b.name === state.selected}">
        <span class="bx-rank-name">${escape(b.name)}${noCode ? ' <span class="bx-dot" title="No code"></span>' : ''}</span>
        <span class="bx-rank-bar"><span style="width:${pct}%"></span></span>
        <span class="bx-rank-meta">${b.pages.size} page${b.pages.size === 1 ? '' : 's'} · ${b.uses}×</span>
      </button>
    </li>`;
  }).join('') || '<li class="bx-muted">No blocks found in scope.</li>';
}

function renderDetail(blocks) {
  const b = blocks.find((x) => x.name === state.selected) || blocks[0];
  if (!b) {
    el.detail.innerHTML = '';
    return;
  }
  state.selected = b.name;
  const code = state.codeExists[b.name];
  let codeBadge = '<span class="bx-badge">System</span>';
  if (!SYSTEM_BLOCKS.has(b.name)) {
    codeBadge = code === false
      ? '<span class="bx-badge bx-badge-error">No code</span>'
      : `<a class="bx-badge bx-badge-ok" href="/blocks/${escape(b.name)}/${escape(b.name)}.js" target="_blank" rel="noopener">Code ✓</a>`;
  }
  const variants = [...b.variants.entries()].sort((x, y) => y[1] - x[1]);
  const pages = [...b.pages.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
  const share = Math.round((b.pages.size / state.pages.length) * 100);

  el.detail.innerHTML = `
    <div class="bx-detail-head">
      <h2>${escape(b.name)}</h2>
      ${codeBadge}
    </div>
    <p class="bx-muted">On <strong>${share}%</strong> of pages · ${b.uses} instance${b.uses === 1 ? '' : 's'} · ${variants.length} variant combo${variants.length === 1 ? '' : 's'}</p>
    <h3>Variants</h3>
    <div class="bx-variants">
      ${variants.map(([v, n]) => `<span class="bx-chip">${escape(v)} <b>${n}</b></span>`).join('')}
    </div>
    <h3>Pages</h3>
    <ul class="bx-pages">
      ${pages.map(([path, n]) => `<li>
        <span class="bx-path" title="${escape(path)}">${escape(webPath(path))}</span>
        ${n > 1 ? `<span class="bx-count">${n}×</span>` : ''}
        <a href="${escape(editUrl(path))}" target="_blank" rel="noopener">Edit</a>
        <a href="${escape(previewUrl(path))}" target="_blank" rel="noopener">Preview</a>
      </li>`).join('')}
    </ul>`;
}

function renderPages() {
  const q = el.search.value.trim().toLowerCase();
  const rows = state.pages
    .map((page) => ({
      ...page,
      visible: page.blocks.filter((b) => state.showSystem || !SYSTEM_BLOCKS.has(b.name)),
    }))
    .filter((page) => !q || page.path.toLowerCase().includes(q)
      || page.visible.some((b) => b.name.includes(q)))
    .sort((a, b) => a.path.localeCompare(b.path));

  el.tbody.innerHTML = rows.map((page) => {
    const counts = new Map();
    page.visible.forEach((b) => counts.set(b.name, (counts.get(b.name) || 0) + 1));
    const chips = [...counts.entries()].map(([name, n]) => {
      const err = state.codeExists[name] === false && !SYSTEM_BLOCKS.has(name) ? ' bx-chip-error' : '';
      return `<button type="button" class="bx-chip${err}" data-block="${escape(name)}">${escape(name)}${n > 1 ? ` <b>${n}</b>` : ''}</button>`;
    }).join('');
    return `<tr>
      <td class="bx-path" title="${escape(page.path)}">${escape(webPath(page.path))}</td>
      <td>${chips || '<span class="bx-muted">Default content only</span>'}</td>
      <td class="bx-num">${page.visible.length}</td>
      <td class="bx-links">
        <a href="${escape(editUrl(page.path))}" target="_blank" rel="noopener">Edit</a>
        <a href="${escape(previewUrl(page.path))}" target="_blank" rel="noopener">Preview</a>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" class="bx-muted">No pages match.</td></tr>';
}

function render() {
  if (!state.pages.length) return;
  const blocks = aggregate();
  el.empty.hidden = true;
  el.results.hidden = false;
  el.scanned.textContent = state.scannedAt
    ? `Scanned ${new Date(state.scannedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
    : '';
  renderKpis(blocks);
  renderAlerts(blocks);
  renderRanking(blocks);
  renderDetail(blocks);
  renderPages();
}

function selectTab(name) {
  el.tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  el.panels.forEach((p) => { p.hidden = p.dataset.panel !== name; });
}

/* ---------- Persistence & export ---------- */

function saveScan() {
  try {
    localStorage.setItem(storageKey(), JSON.stringify({
      pages: state.pages,
      codeExists: state.codeExists,
      libraryBlocks: state.libraryBlocks,
      scannedAt: state.scannedAt,
    }));
  } catch (e) { /* storage unavailable or full */ }
}

function restoreScan() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey()));
    if (saved?.pages?.length) Object.assign(state, saved);
  } catch (e) { /* ignore */ }
}

function exportCsv() {
  const quote = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = [['page', 'block', 'variants', 'has_code'].join(',')];
  state.pages.forEach((page) => {
    page.blocks.forEach((b) => {
      lines.push([webPath(page.path), b.name, b.variants.join(' '), state.codeExists[b.name] ?? '']
        .map(quote).join(','));
    });
  });
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${state.repo}-blocks.csv` });
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------- Scan ---------- */

async function scan(scope, excludes) {
  el.submit.disabled = true;
  setMessage('');
  try {
    setProgress('Discovering pages…', 0.02);
    const paths = await crawl(scope, excludes);
    if (!paths.length) throw new Error(`No pages found in ${scope}`);

    const pages = [];
    let done = 0;
    let failed = 0;
    await runPool(paths, async (path) => {
      try {
        const resp = await authFetch(`${DA_ADMIN}/source/${state.org}/${state.repo}${path}`);
        if (!resp.ok) throw new Error(resp.status);
        pages.push({ path, blocks: parseBlocks(await resp.text()) });
      } catch (e) {
        failed += 1;
      }
      done += 1;
      setProgress(`Analyzing pages… ${done}/${paths.length}`, 0.05 + (done / paths.length) * 0.85);
    });

    setProgress('Checking block code…', 0.95);
    const names = [...new Set(pages.flatMap((p) => p.blocks.map((b) => b.name)))]
      .filter((n) => !SYSTEM_BLOCKS.has(n));
    const [codeExists, libraryBlocks] = await Promise.all([checkCode(names), loadLibraryBlocks()]);

    Object.assign(state, {
      pages, codeExists, libraryBlocks, scannedAt: Date.now(), selected: '',
    });
    saveScan();
    render();
    if (failed) setMessage(`${failed} page(s) could not be read and were skipped.`, 'warn');
  } catch (e) {
    setMessage(e.message, 'error');
  } finally {
    setProgress('', null);
    el.submit.disabled = false;
  }
}

/* ---------- Events ---------- */

el.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const data = new FormData(el.form);
  const norm = (p) => `/${p.trim().replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '/');
  const scope = norm(data.get('scope') || '/');
  const excludes = String(data.get('exclude') || '').split(',').map((s) => s.trim()).filter(Boolean)
    .map(norm);
  scan(scope, excludes);
});

document.addEventListener('click', (e) => {
  const blockBtn = e.target.closest('[data-block]');
  if (blockBtn) {
    state.selected = blockBtn.dataset.block;
    selectTab('blocks');
    render();
    el.detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  const tab = e.target.closest('[data-tab]');
  if (tab) selectTab(tab.dataset.tab);
});

el.system.addEventListener('change', () => {
  state.showSystem = el.system.checked;
  render();
});
el.search.addEventListener('input', renderPages);
el.exportBtn.addEventListener('click', exportCsv);

(async function init() {
  const { context, token } = await DA_SDK;
  state.org = context.org;
  state.repo = context.repo;
  state.token = token;
  el.site.textContent = `${state.org}/${state.repo}`;
  const site = `${state.org}/${state.repo}`;
  document.querySelector('[data-nav="browse"]').href = `https://da.live/#/${site}`;
  document.querySelector('[data-nav="apps"]').href = `https://da.live/apps#/${site}`;
  restoreScan();
  render();
}());
