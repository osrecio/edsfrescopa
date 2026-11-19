// eslint-disable-next-line import/no-unresolved
import DA_SDK from 'https://da.live/nx/utils/sdk.js';

const DA_ADMIN = 'https://admin.da.live';
const AEM_ADMIN = 'https://admin.hlx.page';
const BRANCH = 'main';
const CONCURRENCY = 5;

const el = {
  crumbs: document.querySelector('.ps-crumbs'),
  tbody: document.querySelector('.ps-table tbody'),
  all: document.querySelector('.ps-all'),
  count: document.querySelector('.ps-count'),
  message: document.querySelector('.ps-message'),
  buttons: [...document.querySelectorAll('.ps-btn')],
};

const state = {
  org: '',
  repo: '',
  token: '',
  folder: '/',
  pages: [],
  selected: new Set(),
  busy: false,
};

const escape = (str) => String(str ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const formatDate = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

// "/formacion/test2.html" -> "/formacion/test2", "/formacion/index.html" -> "/formacion/"
const toWebPath = (daPath) => daPath.replace(/\.html$/, '').replace(/\/index$/, '/');

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

function statusCell(info) {
  if (!info) return '<span class="ps-badge ps-loading">…</span>';
  if (info.error) return '<span class="ps-badge ps-error">Error</span>';
  if (info.status !== 200) return '<span class="ps-badge ps-none">Never</span>';
  const stale = info.edited && info.lastModified
    && new Date(info.edited) > new Date(info.lastModified);
  return `<span class="ps-badge ${stale ? 'ps-stale' : 'ps-ok'}" title="${stale ? 'Edited since' : 'Up to date'}">${escape(formatDate(info.lastModified))}</span>`;
}

function updateToolbar() {
  const n = state.selected.size;
  el.count.textContent = n ? `${n} selected` : '';
  el.buttons.forEach((btn) => { btn.disabled = !n || state.busy; });
  const pageCount = state.pages.filter((p) => p.ext === 'html').length;
  el.all.checked = pageCount > 0 && n === pageCount;
  el.all.indeterminate = n > 0 && n < pageCount;
}

function renderCrumbs() {
  const parts = state.folder.split('/').filter(Boolean);
  const links = [`<a href="#/">${escape(state.repo)}</a>`];
  parts.forEach((part, i) => {
    const path = `/${parts.slice(0, i + 1).join('/')}`;
    links.push(`<a href="#${escape(path)}">${escape(part)}</a>`);
  });
  el.crumbs.innerHTML = links.join('<span aria-hidden="true">/</span>');
}

function renderRows() {
  if (!state.pages.length) {
    el.tbody.innerHTML = '<tr><td colspan="5" class="ps-empty">This folder is empty.</td></tr>';
    return;
  }
  el.tbody.innerHTML = state.pages.map((item) => {
    if (!item.ext) {
      return `<tr class="ps-folder">
        <td></td>
        <td colspan="4"><a href="#${escape(item.path)}">📁 ${escape(item.name)}</a></td>
      </tr>`;
    }
    if (item.ext !== 'html') {
      return `<tr class="ps-file">
        <td></td>
        <td>${escape(item.name)}.${escape(item.ext)}</td>
        <td>${escape(formatDate(item.lastModified))}</td>
        <td colspan="2"></td>
      </tr>`;
    }
    const checked = state.selected.has(item.path) ? 'checked' : '';
    const editUrl = `https://da.live/edit#/${state.org}/${state.repo}${item.path.replace(/\.html$/, '')}`;
    return `<tr data-path="${escape(item.path)}">
      <td class="ps-check"><input type="checkbox" ${checked} aria-label="Select ${escape(item.name)}"></td>
      <td><a href="${escape(editUrl)}" target="_blank" rel="noopener">${escape(item.name)}</a></td>
      <td>${escape(formatDate(item.lastModified))}</td>
      <td>${statusCell(item.preview)}</td>
      <td>${statusCell(item.live)}</td>
    </tr>`;
  }).join('');
}

async function loadStatus(page) {
  try {
    const url = `${AEM_ADMIN}/status/${state.org}/${state.repo}/${BRANCH}${toWebPath(page.path)}`;
    const resp = await authFetch(url);
    if (!resp.ok) throw new Error(resp.status);
    const json = await resp.json();
    page.preview = { ...json.preview, edited: page.lastModified };
    page.live = { ...json.live, edited: page.lastModified };
  } catch (e) {
    page.preview = { error: true };
    page.live = { error: true };
  }
  renderRows();
}

async function loadFolder() {
  state.folder = decodeURIComponent(window.location.hash.slice(1)) || '/';
  state.selected.clear();
  state.pages = [];
  renderCrumbs();
  el.tbody.innerHTML = '<tr><td colspan="5" class="ps-empty">Loading…</td></tr>';
  updateToolbar();
  setMessage('');

  const folder = state.folder === '/' ? '' : state.folder;
  const resp = await authFetch(`${DA_ADMIN}/list/${state.org}/${state.repo}${folder}`);
  if (!resp.ok) {
    el.tbody.innerHTML = '';
    setMessage(`Could not list ${state.folder} (${resp.status}).`, 'error');
    return;
  }
  const items = await resp.json();
  const prefix = `/${state.org}/${state.repo}`;
  state.pages = items
    .map((item) => ({ ...item, path: item.path.slice(prefix.length) }))
    .sort((a, b) => (!a.ext - !b.ext) * -1 || a.name.localeCompare(b.name));
  renderRows();
  updateToolbar();
  await runPool(state.pages.filter((p) => p.ext === 'html'), loadStatus);
}

async function bulkAction(action) {
  const label = action === 'live' ? 'Publishing' : 'Previewing';
  const targets = state.pages.filter((p) => state.selected.has(p.path));
  let done = 0;
  const failed = [];
  state.busy = true;
  updateToolbar();
  setMessage(`${label} 0/${targets.length}…`);

  await runPool(targets, async (page) => {
    const url = `${AEM_ADMIN}/${action}/${state.org}/${state.repo}/${BRANCH}${toWebPath(page.path)}`;
    try {
      const resp = await authFetch(url, { method: 'POST' });
      if (!resp.ok) throw new Error(resp.headers.get('x-error') || resp.status);
    } catch (e) {
      failed.push(`${page.name}: ${e.message}`);
    }
    done += 1;
    setMessage(`${label} ${done}/${targets.length}…`);
    await loadStatus(page);
  });

  state.busy = false;
  state.selected.clear();
  renderRows();
  updateToolbar();
  if (failed.length) {
    setMessage(`${failed.length} failed — ${failed.join('; ')}`, 'error');
  } else {
    setMessage(`Done: ${targets.length} page(s) ${action === 'live' ? 'published' : 'previewed'}.`, 'ok');
  }
}

el.tbody.addEventListener('change', (e) => {
  const row = e.target.closest('tr[data-path]');
  if (!row) return;
  if (e.target.checked) state.selected.add(row.dataset.path);
  else state.selected.delete(row.dataset.path);
  updateToolbar();
});

el.all.addEventListener('change', () => {
  state.selected = new Set(el.all.checked
    ? state.pages.filter((p) => p.ext === 'html').map((p) => p.path)
    : []);
  renderRows();
  updateToolbar();
});

el.buttons.forEach((btn) => {
  btn.addEventListener('click', () => bulkAction(btn.dataset.action));
});

window.addEventListener('hashchange', loadFolder);

(async function init() {
  const { context, token } = await DA_SDK;
  state.org = context.org;
  state.repo = context.repo;
  state.token = token;
  loadFolder();
}());
