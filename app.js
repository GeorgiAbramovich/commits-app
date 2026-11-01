'use strict';

const API = 'https://api.github.com';
const PAGE = 30;
const view = document.getElementById('view');
const bar = document.querySelector('.bar');
const ui = {
  back: document.getElementById('back'),
  title: document.getElementById('title'),
  subtitle: document.getElementById('subtitle'),
  refresh: document.getElementById('refresh'),
  settings: document.getElementById('settings'),
  toast: document.getElementById('toast'),
  install: document.getElementById('install'),
};

// ---------- storage (never fatal) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

let token = store.get('token', null);
let pins = store.get('pins', []);
const cache = new Map();

// Inside the Android app, hand the token and pins to the home screen widget.
const native = window.CommitsAndroid;
const syncNative = () => native?.postMessage(JSON.stringify({ token, pins }));

// Merge notifications live in the Android app; it tells us whether they're really on (permission can be denied).
let notifyOn = store.get('notify', false);
if (native) native.onmessage = e => {
  const data = JSON.parse(e.data);
  if (typeof data.notify !== 'boolean') return;
  notifyOn = data.notify;
  store.set('notify', notifyOn);
  document.getElementById('notify')?.setAttribute('aria-checked', notifyOn);
};

// ---------- helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = encodeURIComponent;

function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 604800) return Math.floor(s / 86400) + 'd ago';
  if (s < 2592000) return Math.floor(s / 604800) + 'w ago';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const diff = Math.round((today - that) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', ...(d.getFullYear() !== today.getFullYear() && { year: 'numeric' }) });
}

function toast(msg) {
  ui.toast.textContent = msg;
  ui.toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => ui.toast.classList.remove('show'), 1800);
}

function avatar(url, name) {
  if (url) return `<img class="avatar" src="${esc(url)}&s=72" alt="" loading="lazy">`;
  return `<div class="avatar ph">${esc((name || '?').trim().charAt(0).toUpperCase())}</div>`;
}

const LANG = { JavaScript: '#f1e05a', TypeScript: '#3178c6', Python: '#3572a5', Java: '#b07219', Kotlin: '#a97bff', Swift: '#f05138', Go: '#00add8', 'C#': '#178600', 'C++': '#f34b7d', C: '#555555', Ruby: '#701516', PHP: '#4f5d95', Rust: '#dea584', Dart: '#00b4ab', HTML: '#e34c26', CSS: '#563d7c', Shell: '#89e051', ShaderLab: '#222c37', HCL: '#844fba', Dockerfile: '#384d54', Vue: '#41b883', Lua: '#000080', 'Objective-C': '#438eff', Scala: '#c22d40' };

const skeleton = n => `<div class="list">${'<div class="skel"></div>'.repeat(n)}</div>`;

// ---------- author colors ----------
// Shared with the home screen widget (CommitsWidget.kt): same pairs, same hash, same probing,
// so a person keeps one color everywhere. Each pair is a deep shade for light mode and a soft
// one for dark mode; cards get a wash of it over white / #1C1B1F.
const AUTHOR_COLORS = [
  ['#00695c', '#4db6ac'], // teal
  ['#b23c00', '#ffb74d'], // orange
  ['#ad1457', '#f48fb1'], // pink
  ['#1259b5', '#64b5f6'], // blue
  ['#6a1b9a', '#ce93d8'], // purple
  ['#236c28', '#81c784'], // green
  ['#7a5c00', '#ffd54f'], // amber
  ['#3949ab', '#9fa8da'], // indigo
  ['#b71c1c', '#ef9a9a'], // red
  ['#006874', '#4dd0e1'], // cyan
];

// Java's String.hashCode() (32-bit overflow) on the lowercased name, then Math.floorMod.
function authorSlot(author) {
  const s = String(author).toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return ((h % AUTHOR_COLORS.length) + AUTHOR_COLORS.length) % AUTHOR_COLORS.length;
}

// Authors on one screen take the next free color when theirs is taken, like the widget does.
function authorSlots(authors) {
  const taken = new Array(AUTHOR_COLORS.length).fill(false);
  const slots = new Map();
  for (const a of authors) {
    if (slots.has(a)) continue;
    let slot = authorSlot(a);
    if (taken.every(Boolean)) taken.fill(false);
    while (taken[slot]) slot = (slot + 1) % AUTHOR_COLORS.length;
    taken[slot] = true;
    slots.set(a, slot);
  }
  return slots;
}

// ColorUtils.blendARGB, truncating each channel like Android does.
function blend(a, b, r) {
  const ch = (c, i) => parseInt(c.slice(1 + i * 2, 3 + i * 2), 16);
  return '#' + [0, 1, 2].map(i => Math.trunc(ch(a, i) * (1 - r) + ch(b, i) * r).toString(16).padStart(2, '0')).join('');
}

// Custom properties for one author color; style.css picks the light or dark pair.
function tintVars(slot) {
  const [light, dark] = AUTHOR_COLORS[slot];
  return `--al:${light};--ad:${dark};--wl:${blend('#ffffff', light, .16)};--wd:${blend('#1c1b1f', dark, .2)}`;
}

// ---------- GitHub API ----------
async function gh(path, { fresh = false } = {}) {
  if (!fresh && cache.has(path)) return cache.get(path);
  const res = await fetch(API + path, {
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    cache: 'no-store',
  });
  if (res.status === 401) {
    signOut();
    throw new Error('Your token is invalid or expired. Please add a new one.');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    let msg = body.message || `GitHub returned ${res.status}`;
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') msg = 'GitHub rate limit reached. Try again in a few minutes.';
    else if (res.status === 403 && /SAML|SSO/i.test(msg)) msg = 'This org uses SSO. On github.com, open your token and click "Configure SSO" → Authorize for this org.';
    else if (res.status === 409) msg = 'This repository is empty.';
    throw new Error(msg);
  }
  const data = await res.json();
  cache.set(path, data);
  return data;
}

// ---------- chrome ----------
function setBar({ title, subtitle = '', back = null, refresh = false, settings = false, install = false }) {
  ui.title.textContent = title;
  ui.subtitle.textContent = subtitle;
  ui.back.hidden = !back;
  ui.back.onclick = () => up(back);
  ui.refresh.hidden = !refresh;
  ui.settings.hidden = !settings;
  showInstall = install;
  ui.install.hidden = !(install && installPrompt);
  pullEnabled = refresh;
  document.title = title && title !== 'Commits' ? `${title} – Commits` : 'Commits';
}

ui.settings.onclick = () => nav('#/settings');
ui.refresh.onclick = () => refresh();

// The status bar color (theme-color) follows the top bar, which tints once content scrolls under it.
const themeMetas = document.querySelectorAll('meta[name="theme-color"]');
function syncThemeColor() {
  const color = getComputedStyle(document.documentElement)
    .getPropertyValue(bar.classList.contains('scrolled') ? '--bar-scrolled' : '--bg').trim();
  if (color) themeMetas.forEach(m => (m.content = color));
}
addEventListener('scroll', () => {
  const scrolled = scrollY > 4;
  if (scrolled !== bar.classList.contains('scrolled')) {
    bar.classList.toggle('scrolled', scrolled);
    syncThemeColor();
  }
}, { passive: true });
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', syncThemeColor);

function showError(e, el = view) {
  el.innerHTML = `<div class="error fade">${esc(e.message || e)}</div>`;
}

const buzz = ms => { try { navigator.vibrate?.(ms); } catch {} };

// ---------- navigation ----------
// Every history entry we create carries { d: depth } (0 = home), so the in-app Back arrow and the
// Android back gesture walk the same stack, even after a reload. Scroll position is saved per entry.
history.scrollRestoration = 'manual';
let here = 0;

function parentOf(hash) {
  const p = hash.replace(/^#\/?/, '').split('?')[0].split('/');
  if (p[0] === 'c' && p[3]) return `#/r/${p[1]}/${p[2]}`;
  if (p[0] === 'r' || p[0] === 'settings') return '#/';
  return null;
}

// Opened straight on a deep link (shared URL, fresh tab)? Put its parents underneath so
// Back goes commit -> repo -> home instead of closing the app.
function seedHistory() {
  if (history.state && typeof history.state.d === 'number') { here = history.state.d; return; }
  const chain = [];
  for (let h = location.hash.length > 2 ? location.hash : '#/'; h; h = parentOf(h)) chain.unshift(h);
  history.replaceState({ d: 0 }, '', chain[0]);
  chain.slice(1).forEach((h, i) => history.pushState({ d: i + 1 }, '', h));
  here = chain.length - 1;
}

function nav(hash) {
  if (hash === location.hash) return route();
  history.replaceState({ ...history.state, y: scrollY }, '');
  history.pushState({ d: ++here }, '', hash);
  route();
}

function replaceNav(hash) {
  history.replaceState({ d: here }, '', hash);
  route();
}

// In-app Back arrow: pop if there is an in-app entry below us, otherwise swap in the parent screen.
function up(fallback) {
  if (here > 0) history.back();
  else replaceNav(fallback);
}

function goHome() {
  if (here > 0) history.go(-here);
  else replaceNav('#/');
}

addEventListener('popstate', () => {
  const s = history.state;
  if (s && typeof s.d === 'number') {
    here = s.d;
    route({ restoreY: s.y });
  } else {
    // A hash typed in or linked from elsewhere: treat it as a forward step.
    history.replaceState({ d: ++here }, '');
    route();
  }
});

// In-app links (commit rows) go through nav() so their entries get a depth.
document.addEventListener('click', e => {
  const a = e.target.closest('a[href^="#/"]');
  if (!a || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  nav(a.getAttribute('href'));
});

// ---------- router ----------
let navToken = 0;

async function route({ keepScroll = false, restoreY = null } = {}) {
  const my = ++navToken;
  const stale = () => my !== navToken;
  // An optional ?query can follow the path, e.g. #/c/owner/repo/sha?tint=3 from the widget.
  const [path, query = ''] = location.hash.split(/\?(.*)/s);
  const parts = path.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const params = new URLSearchParams(query);
  if (!keepScroll) scrollTo(0, 0);

  if (!token) return setupView();
  try {
    if (parts[0] === 'settings') await settingsView(stale);
    else if (parts[0] === 'r' && parts[2]) await repoView(parts[1], parts[2], parts[3], stale);
    else if (parts[0] === 'c' && parts[3]) await commitView(parts[1], parts[2], parts[3], stale, params.get('tint'));
    else await homeView(stale);
    if (restoreY && !stale()) scrollTo(0, restoreY);
  } catch (e) {
    if (stale()) return;
    if (!token) setupView(e.message); // token was rejected: ask for a new one
    else showError(e);
  }
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  cache.clear();
  ui.refresh.classList.add('spin');
  try { await route({ keepScroll: true }); }
  finally {
    refreshing = false;
    ui.refresh.classList.remove('spin');
    pullReset();
  }
}

// ---------- pull to refresh ----------
// Installed PWAs don't get Chrome's pull-to-refresh, so the home and repo screens draw their own.
const ptr = document.getElementById('ptr');
const ptrArc = ptr.querySelector('circle');
const PULL_MAX = 128, PULL_TRIGGER = 72;
let pullEnabled = false, pullStart = null, pullX = 0, pull = 0;

function pullDraw(dist) {
  const p = Math.min(dist / PULL_TRIGGER, 1);
  ptr.style.opacity = Math.min(dist / 24, 1);
  ptr.style.transform = `translateY(${dist}px) rotate(${dist * 2.5}deg)`;
  ptrArc.style.strokeDashoffset = 50.3 * (1 - p * .8);
}

function pullReset() {
  ptr.classList.remove('busy');
  ptr.classList.add('settle');
  ptr.style.opacity = 0;
  ptr.style.transform = 'translateY(0)';
  ptrArc.style.strokeDashoffset = '';
  pull = 0;
}

addEventListener('touchstart', e => {
  if (!pullEnabled || refreshing || scrollY > 0 || e.touches.length !== 1) return;
  pullStart = e.touches[0].clientY;
  pullX = e.touches[0].clientX;
  ptr.classList.remove('settle');
}, { passive: true });

addEventListener('touchmove', e => {
  if (pullStart == null) return;
  const t = e.touches[0];
  const dy = t.clientY - pullStart;
  // Let go on sideways swipes (owner chips) and on ordinary scrolling.
  if (scrollY > 0 || (pull === 0 && Math.abs(t.clientX - pullX) > Math.abs(dy))) { pullStart = null; pullReset(); return; }
  const before = pull;
  pull = dy <= 0 ? 0 : Math.min(PULL_MAX, dy * .55);
  if (before < PULL_TRIGGER && pull >= PULL_TRIGGER) buzz(8);
  pullDraw(pull);
}, { passive: true });

addEventListener('touchend', () => {
  if (pullStart == null) return;
  pullStart = null;
  if (pull >= PULL_TRIGGER) {
    ptr.classList.add('settle', 'busy');
    ptr.style.transform = `translateY(${PULL_TRIGGER}px)`;
    refresh();
  } else pullReset();
});
addEventListener('touchcancel', () => { pullStart = null; if (!refreshing) pullReset(); });

// ---------- ripple ----------
// Waits a beat on touch so a scroll that starts on a row doesn't flash it.
const RIPPLE = '.row, .chip, .icon-btn, .text-btn, .pill, .more, .primary, .pin, .branch, .file summary, .toggle-all';
document.addEventListener('pointerdown', e => {
  const el = e.target.closest(RIPPLE);
  if (!el || el.disabled || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  let wave = null;
  const show = () => {
    const r = el.getBoundingClientRect();
    const size = Math.hypot(r.width, r.height) * 2;
    wave = document.createElement('span');
    wave.className = 'ripple';
    wave.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    el.append(wave);
  };
  const timer = setTimeout(show, e.pointerType === 'touch' ? 70 : 0);
  const done = ev => {
    removeEventListener('pointerup', done);
    removeEventListener('pointercancel', done);
    clearTimeout(timer);
    if (!wave && ev.type === 'pointerup') show();
    if (!wave) return;
    const w = wave;
    setTimeout(() => { w.classList.add('out'); setTimeout(() => w.remove(), 300); }, 150);
  };
  addEventListener('pointerup', done);
  addEventListener('pointercancel', done);
}, { passive: true });

// ---------- install ----------
// Chrome's mini-infobar is suppressed; a quiet Install button shows on the home and setup screens instead.
let installPrompt = null, showInstall = false;
addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
  ui.install.hidden = !showInstall;
});
ui.install.onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice.catch(() => {});
  installPrompt = null;
  ui.install.hidden = true;
};
addEventListener('appinstalled', () => { installPrompt = null; ui.install.hidden = true; });

// ---------- views ----------
function setupView(error = '') {
  setBar({ title: '', install: true });
  view.innerHTML = `
    <div class="hero fade">
      <img src="icon.svg" alt="">
      <h1>Commits</h1>
      <p>The latest commits across your GitHub organizations, one tap away.</p>
    </div>
    <div class="card fade" style="margin-top:28px">
      <form id="tok">
        <input class="field" id="tokIn" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="ghp_… or github_pat_…" aria-label="GitHub token" required>
        <button class="primary" type="submit">Connect GitHub</button>
      </form>
      <div id="tokErr">${error ? `<div class="error">${esc(error)}</div>` : ''}</div>
      <ol class="steps">
        <li><a href="https://github.com/settings/tokens/new?scopes=repo,read:org&description=Commits%20app" target="_blank" rel="noopener">Create a token on GitHub</a> with the <b>repo</b> and <b>read:org</b> scopes.</li>
        <li>If your org uses SSO, choose <b>Configure SSO</b>, then <b>Authorize</b> next to the token.</li>
        <li>Paste it above. It stays on this device and is only sent to api.github.com.</li>
      </ol>
    </div>`;
  const form = document.getElementById('tok');
  form.onsubmit = async e => {
    e.preventDefault();
    const btn = form.querySelector('button');
    const val = document.getElementById('tokIn').value.trim();
    btn.disabled = true; btn.textContent = 'Checking…';
    token = val;
    try {
      const me = await gh('/user', { fresh: true });
      store.set('token', token);
      syncNative();
      toast(`Signed in as ${me.login}`);
      route();
    } catch (err) {
      token = null;
      document.getElementById('tokErr').innerHTML = `<div class="error">${esc(err.message)}</div>`;
      btn.disabled = false; btn.textContent = 'Connect GitHub';
    }
  };
}

function signOut() {
  token = null;
  store.del('token');
  cache.clear();
  syncNative();
}

async function settingsView(stale) {
  setBar({ title: 'Settings', back: '#/' });
  view.innerHTML = skeleton(1);
  const me = await gh('/user');
  if (stale()) return;
  view.innerHTML = `
    <div class="section-label">Account</div>
    <div class="list fade">
      <div class="row">${avatar(me.avatar_url, me.login)}
        <div class="row-main"><div class="row-title">${esc(me.name || me.login)}</div><div class="row-desc">@${esc(me.login)}</div></div>
      </div>
    </div>
    <div class="section-label">Pinned repos</div>
    <div class="list fade">
      <div class="row"><div class="row-main">${pins.length ? pins.map(esc).join('<br>') : '<span class="row-desc">Tap the star on a repo to pin it to the top.</span>'}</div></div>
    </div>
    ${native ? `
    <div class="section-label">Notifications</div>
    <div class="list fade">
      <button class="row switch-row" id="notify" role="switch" aria-checked="${notifyOn}">
        <div class="row-main"><div class="row-title">Merged pull requests</div>
          <div class="row-desc">Notify me when a PR is merged in a pinned repo. Checked about every 15 minutes.</div></div>
        <span class="switch" aria-hidden="true"></span>
      </button>
    </div>` : ''}
    <div class="list fade" style="margin-top:24px">
      <button class="row danger" id="out">Sign out</button>
    </div>`;
  const notify = document.getElementById('notify');
  if (notify) notify.onclick = () => {
    notify.setAttribute('aria-checked', !notifyOn); // the app confirms (or reverts) once Android answers
    native.postMessage(JSON.stringify({ notify: !notifyOn }));
  };
  document.getElementById('out').onclick = () => {
    if (!confirm('Sign out and remove the token from this device?')) return;
    signOut();
    goHome();
  };
}

async function homeView(stale) {
  visit = null; // going home ends a repo visit; the next one marks only what's newer than now
  setBar({ title: 'Commits', refresh: true, settings: true, install: true });
  view.innerHTML = `<div class="chips"></div>${skeleton(6)}`;

  const [me, orgs] = await Promise.all([gh('/user'), gh('/user/orgs?per_page=100')]);
  if (stale()) return;
  const owners = [
    ...orgs.map(o => ({ login: o.login, avatar: o.avatar_url, org: true })),
    { login: me.login, avatar: me.avatar_url, org: false },
  ];
  let owner = owners.find(o => o.login === store.get('owner')) || owners[0];

  view.innerHTML = `
    <div class="chips fade">${owners.map(o => `
      <button class="chip" data-o="${esc(o.login)}"><img src="${esc(o.avatar)}&s=52" alt="">${esc(o.login)}</button>`).join('')}
    </div>
    <input class="search" type="search" placeholder="Search repositories" autocomplete="off">
    <div id="repos"></div>`;

  const chips = view.querySelectorAll('.chip');
  const search = view.querySelector('.search');
  const box = view.querySelector('#repos');
  let repos = [];

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const list = repos.filter(r => !q || r.name.toLowerCase().includes(q) || (r.description || '').toLowerCase().includes(q));
    const pinned = list.filter(r => pins.includes(r.full_name));
    const rest = list.filter(r => !pins.includes(r.full_name));
    if (!list.length) { box.innerHTML = `<div class="empty">${q ? 'No matching repositories' : 'No repositories here yet'}</div>`; return; }
    box.innerHTML =
      (pinned.length ? `<div class="section-label">Pinned</div><div class="list">${pinned.map(repoRow).join('')}</div>` : '') +
      (rest.length ? `<div class="section-label">Recently pushed</div><div class="list">${rest.map(repoRow).join('')}</div>` : '');
  };

  box.onclick = e => {
    const pin = e.target.closest('.pin');
    const row = e.target.closest('[data-r]');
    if (!row) return;
    if (pin) {
      const name = row.dataset.r;
      pins = pins.includes(name) ? pins.filter(p => p !== name) : [...pins, name];
      store.set('pins', pins);
      syncNative();
      buzz(10);
      toast(pins.includes(name) ? 'Pinned to the top' : 'Unpinned');
      draw();
      return;
    }
    nav(`#/r/${row.dataset.r.split('/').map(enc).join('/')}`);
  };
  box.onkeydown = e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-r]')) { e.preventDefault(); e.target.click(); }
  };
  search.oninput = draw;

  const load = async o => {
    owner = o;
    store.set('owner', o.login);
    chips.forEach(c => c.classList.toggle('on', c.dataset.o === o.login));
    view.querySelector('.chip.on')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    box.innerHTML = `<div class="section-label">&nbsp;</div>${skeleton(6)}`;
    const path = o.org
      ? `/orgs/${enc(o.login)}/repos?sort=pushed&direction=desc&per_page=100`
      : `/user/repos?affiliation=owner&sort=pushed&direction=desc&per_page=100`;
    try {
      const data = await gh(path);
      if (stale() || owner !== o) return;
      repos = data.sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at));
      draw();
    } catch (e) {
      if (!stale()) showError(e, box);
    }
  };
  chips.forEach(c => (c.onclick = () => { search.value = ''; load(owners.find(o => o.login === c.dataset.o)); }));
  await load(owner);
}

function repoRow(r) {
  const on = pins.includes(r.full_name);
  return `
    <div class="row" role="button" tabindex="0" data-r="${esc(r.full_name)}">
      <div class="row-main">
        <div class="row-title">${esc(r.name)}${r.private ? '' : ' <span class="badge">public</span>'}${r.archived ? ' <span class="badge">archived</span>' : ''}</div>
        ${r.description ? `<div class="row-desc">${esc(r.description)}</div>` : ''}
        <div class="meta">
          ${r.language ? `<span><i class="dot" style="background:${LANG[r.language] || 'var(--muted)'}"></i>${esc(r.language)}</span>` : ''}
          <span>Pushed ${ago(r.pushed_at)}</span>
        </div>
      </div>
      <button class="pin${on ? ' on' : ''}" aria-label="${on ? 'Unpin' : 'Pin'}">
        <svg viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>
      </button>
    </div>`;
}

// "New since you last looked": per repo and branch, the newest commit date seen. The threshold read on
// arrival holds for the whole visit (refreshing, opening a commit and coming back), so markers don't
// vanish under your thumb. A branch you've never opened has no threshold, so nothing is marked new.
let visit = null; // { key, since }
const landed = c => c.commit.committer?.date || c.commit.author?.date;

async function repoView(owner, name, branch, stale) {
  const full = `${owner}/${name}`;
  setBar({ title: name, subtitle: owner, back: '#/', refresh: true });
  view.innerHTML = skeleton(8);

  const [repo, branches] = await Promise.all([
    gh(`/repos/${enc(owner)}/${enc(name)}`),
    gh(`/repos/${enc(owner)}/${enc(name)}/branches?per_page=100`),
  ]);
  if (stale()) return;
  branch = branch || repo.default_branch;
  const names = branches.map(b => b.name);
  if (!names.includes(branch)) names.unshift(branch);
  names.sort((a, b) => (a === repo.default_branch ? -1 : b === repo.default_branch ? 1 : a.localeCompare(b)));

  view.innerHTML = `
    <label class="branch fade">
      <svg viewBox="0 0 24 24"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-12 3-12 8"/></svg>
      <select aria-label="Branch">${names.map(n => `<option${n === branch ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>
      <svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>
    </label>
    <div id="commits"></div>`;
  view.querySelector('select').onchange = e =>
    replaceNav(`#/r/${enc(owner)}/${enc(name)}/${enc(e.target.value)}`);

  const key = `seen:${full}@${branch}`;
  if (visit?.key !== key) visit = { key, since: store.get(key, null) };
  const since = visit.since ? Date.parse(visit.since) : Infinity;

  const box = view.querySelector('#commits');
  box.innerHTML = skeleton(8);
  let page = 1;
  let all = [];

  const loadPage = async () => {
    const data = await gh(`/repos/${enc(owner)}/${enc(name)}/commits?sha=${enc(branch)}&per_page=${PAGE}&page=${page}`);
    if (stale()) return;
    all = all.concat(data);
    const dates = [store.get(key, null), ...data.map(landed)].filter(Boolean);
    if (dates.length) store.set(key, dates.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)));
    const slots = authorSlots(all.map(authorOf));
    const groups = [];
    for (const c of all) {
      const label = dayLabel(c.commit.author?.date || c.commit.committer?.date);
      if (!groups.length || groups.at(-1).label !== label) groups.push({ label, items: [] });
      groups.at(-1).items.push(c);
    }
    box.innerHTML = all.length
      ? groups.map(g => `<div class="section-label">${esc(g.label)}</div><div class="list timeline">${g.items.map(c => commitRow(c, full, c === all[0], slots.get(authorOf(c)), Date.parse(landed(c)) > since)).join('')}</div>`).join('') +
        (data.length === PAGE ? '<button class="more">Load older commits</button>' : '')
      : '<div class="empty">No commits on this branch</div>';
    const more = box.querySelector('.more');
    if (more) more.onclick = async () => {
      more.textContent = 'Loading…'; more.disabled = true;
      page++;
      try { await loadPage(); } catch (e) { more.textContent = e.message; }
    };
  };
  await loadPage();
}

// The name the widget colors by: the GitHub login, or the git author name without one.
const authorOf = c => c.author?.login || c.commit.author?.name || 'unknown';

function commitRow(c, full, head = false, slot = authorSlot(authorOf(c)), fresh = false) {
  const [title] = c.commit.message.split('\n');
  const who = authorOf(c);
  return `
    <a class="row${head ? ' head' : ''}" href="#/c/${full.split('/').map(enc).join('/')}/${enc(c.sha)}?tint=${slot}" style="${tintVars(slot)}">
      ${avatar(c.author?.avatar_url, who)}
      <div class="row-main">
        <div class="commit-msg">${esc(title)}</div>
        <div class="meta">${fresh ? '<span class="new">New</span>' : ''}<span class="who">${esc(who)}</span><span>${ago(c.commit.author?.date)}</span><span class="sha">${esc(c.sha.slice(0, 7))}</span></div>
      </div>
    </a>`;
}

async function commitView(owner, name, sha, stale, tint) {
  setBar({ title: name, subtitle: owner, back: `#/r/${enc(owner)}/${enc(name)}` });
  view.innerHTML = '<div class="commit skel-commit"></div>';
  const c = await gh(`/repos/${enc(owner)}/${enc(name)}/commits/${enc(sha)}`);
  if (stale()) return;

  const [title, ...rest] = c.commit.message.split('\n');
  const body = unwrap(rest.join('\n').trim());
  const who = authorOf(c);
  const fullName = c.commit.author?.name || who;
  const date = new Date(c.commit.author?.date || c.commit.committer?.date);
  // The widget passes the color it showed; it may have moved off the hashed one to avoid a clash.
  const slot = /^\d$/.test(tint ?? '') ? +tint : authorSlot(who);
  const files = c.files || [];
  const { additions = 0, deletions = 0 } = c.stats || {};
  const total = additions + deletions || 1;
  const greens = Math.round((additions / total) * 5);
  const reds = additions + deletions ? Math.min(5 - greens, Math.round((deletions / total) * 5)) : 0;
  const bars = Array.from({ length: 5 }, (_, i) => `<i class="${i < greens ? 'a' : i < greens + reds ? 'd' : ''}"></i>`).join('');
  // Small commits open with every diff showing; bigger ones start as a list of files.
  const openAll = files.length <= 3 && additions + deletions < 300;
  const withPatch = files.filter(f => f.patch).length;

  ui.subtitle.textContent = `${who} · ${ago(date)}`;
  view.innerHTML = `
    <article class="commit fade" style="${tintVars(slot)}">
      <div class="author">
        ${avatar(c.author?.avatar_url, who)}
        <div class="author-text">
          <b>${esc(fullName)}</b>
          <small>${date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</small>
        </div>
      </div>
      <h1 class="detail-title">${refs(esc(title), owner, name)}</h1>
      ${body ? `<div class="detail-body">${refs(body.split(/\n{2,}/).map(bodyBlock).join(''), owner, name)}</div>` : ''}
      <div class="actions">
        <button class="pill mono" id="copy" aria-label="Copy commit SHA">
          <svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>${esc(c.sha.slice(0, 7))}
        </button>
        <a class="pill" href="${esc(c.html_url)}" target="_blank" rel="noopener">
          <svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>GitHub
        </a>
        <button class="pill" id="share">
          <svg viewBox="0 0 24 24"><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/></svg>Share
        </button>
      </div>
    </article>
    <div class="stats">
      <span>${files.length} file${files.length === 1 ? '' : 's'}</span>
      <span class="add">+${additions}</span><span class="del">−${deletions}</span>
      <span class="bars" aria-hidden="true">${bars}</span>
      ${withPatch > 1 ? `<button class="toggle-all" id="toggleAll"></button>` : ''}
    </div>
    <div class="files fade">${files.map(f => fileRow(f, openAll)).join('') || '<div class="empty">No file changes</div>'}</div>
    ${files.length >= 300 ? '<p class="row-desc" style="text-align:center;margin-top:12px">GitHub shows at most 300 files. Open on GitHub for the full diff.</p>' : ''}`;

  document.getElementById('copy').onclick = async () => {
    try { await navigator.clipboard.writeText(c.sha); toast('Commit SHA copied'); }
    catch { toast(c.sha); }
  };

  // Shares the commit's GitHub page: through Android's share sheet in the app, the system one on the
  // web where there is one, otherwise by copying the link.
  document.getElementById('share').onclick = async () => {
    const share = { url: c.html_url, title };
    if (native) return native.postMessage(JSON.stringify({ share }));
    if (navigator.share) {
      try { return await navigator.share(share); }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(share.url); toast('Link copied'); }
    catch { toast(share.url); }
  };

  // Reads "Expand all" until every diff is open, then "Collapse all".
  const toggleAll = document.getElementById('toggleAll');
  if (toggleAll) {
    const details = [...view.querySelectorAll('details.file')].filter(d => d.querySelector('.patch'));
    const sync = () => (toggleAll.textContent = details.every(d => d.open) ? 'Collapse all' : 'Expand all');
    details.forEach(d => d.addEventListener('toggle', sync));
    toggleAll.onclick = () => {
      const open = !details.every(d => d.open);
      details.forEach(d => (d.open = open));
      sync();
    };
    sync();
  }
}

// Commit bodies are usually hard-wrapped at ~72 columns. Rejoin plain prose paragraphs so they
// reflow on a phone, but leave paragraphs with lists, quotes or indented code untouched.
function unwrap(text) {
  return text.split(/\n{2,}/).map(p =>
    // A list: fold each item's indented continuation lines back into the item.
    /^[-*+]\s/.test(p) ? p.replace(/\n[ \t]+(?![-*+]\s|\d+[.)]\s)/g, ' ')
    : /^([ \t]|[-*+>]|\d+[.)])/m.test(p) ? p : p.replace(/[ \t]*\n[ \t]*/g, ' ')
  ).join('\n\n');
}

// One body paragraph. A plain bullet list becomes a real list, so wrapped items hang under their text.
function bodyBlock(p) {
  const lines = p.split('\n');
  if (lines.every(l => /^[-*+]\s/.test(l))) return `<ul>${lines.map(l => `<li>${esc(l.slice(2).trim())}</li>`).join('')}</ul>`;
  return `<p>${esc(p)}</p>`;
}

// Links #123 in already-escaped text to that pull request (GitHub redirects it if it's an issue).
// The # must not follow & or a word character, so entities like &#39; and other/repo#12 stay text.
function refs(html, owner, name) {
  return html.replace(/(?<![&\w])#(\d+)\b/g, (m, n) =>
    `<a class="ref" href="https://github.com/${enc(owner)}/${enc(name)}/pull/${n}" target="_blank" rel="noopener">${m}</a>`);
}

// One diff line. The +/− marker sits in its own gutter; a long line wraps, and its continuation
// hangs two columns past the line's own indentation so nesting stays readable.
function patchLine(l) {
  if (l.startsWith('@@')) {
    const [, range = l, where = ''] = l.match(/^(@@.*?@@)\s*(.*)$/) || [];
    return `<div class="ph"><span>${esc(range)}</span>${where ? ` <span class="where">${esc(where)}</span>` : ''}</div>`;
  }
  if (l.startsWith('\\')) return `<div class="pn">${esc(l.slice(1).trim())}</div>`;
  const kind = l[0] === '+' ? 'pa' : l[0] === '-' ? 'pd' : '';
  const code = l.slice(1);
  const lead = code.match(/^[ \t]*/)[0];
  // Prefer breaking a long line after . ( or , over splitting an identifier.
  const indent = Math.min(24, lead.length + (lead.split('\t').length - 1) * 3); // tabs are 4 wide
  return `<div class="pl ${kind}" style="--i:${indent}ch"><i aria-hidden="true">${kind === 'pa' ? '+' : kind === 'pd' ? '−' : ''}</i><code>${esc(code).replace(/([.(,])(?=\S)/g, '$1<wbr>') || ' '}</code></div>`;
}

function fileRow(f, open = false) {
  const letter = { added: 'A', removed: 'D', modified: 'M', renamed: 'R', copied: 'C', changed: 'M' }[f.status] || 'M';
  const label = { added: 'Added', removed: 'Deleted', renamed: 'Renamed', copied: 'Copied' }[f.status] || 'Modified';
  const slash = f.filename.lastIndexOf('/');
  const dir = slash >= 0 ? f.filename.slice(0, slash) : '';
  const base = f.filename.slice(slash + 1);
  const patch = f.patch
    ? `<div class="patch">${f.patch.split('\n').map(patchLine).join('')}</div>`
    : `<div class="patch-empty">${f.status === 'renamed' && !f.changes ? `Renamed from ${esc(f.previous_filename)}` : 'Binary file or diff too large to show'}</div>`;
  return `
    <details class="file ${esc(f.status)}"${open && f.patch ? ' open' : ''}>
      <summary>
        <span class="finfo">
          <span class="fname">${esc(base).replace(/([-_.])/g, '$1<wbr>')}</span>
          <span class="fmeta">
            <span class="status ${esc(f.status)}" title="${label}">${letter}</span>
            <span class="counts">${f.additions ? `<span class="add">+${f.additions}</span>` : ''}${f.deletions ? `<span class="del">−${f.deletions}</span>` : ''}</span>
            ${dir ? `<em class="fdir">${esc(dir).replace(/\//g, '/<wbr>')}</em>` : ''}
          </span>
        </span>
        <span class="chev" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></span>
      </summary>
      ${patch}
    </details>`;
}

// ---------- boot ----------
if (!native && 'serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
seedHistory();
syncThemeColor();
syncNative();
route();
