// VRShop phone companion. Vanilla ES module, no build step.
// Screens: #/ (capture) · #/s/:id (room + picks) · #/s/:id/cart (cart + checkout links)

const MV_URL = 'https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js';
const MAX_PHOTOS = 12;
const PROMPT_EXAMPLES = ['Cozy reading corner', 'Japandi living room, warm wood', 'Calm home office', 'Small bedroom, more storage'];
const BUDGETS = [500, 1500, 3000];
const ASK_EXAMPLES = ['Black leather sofa under $1,500', 'Anything cheaper?', 'What’s the price range?', 'Round wood coffee table', 'Add the first one to my cart'];
const PRICE_PRESETS = [[0, 0, 'Any price'], [0, 200, 'Under $200'], [0, 500, 'Under $500'], [0, 1000, 'Under $1,000'], [0, 2000, 'Under $2,000'], [1000, 0, '$1,000+']];
const SORTS = [['relevance', 'Best match'], ['price_asc', 'Price: low to high'], ['price_desc', 'Price: high to low'], ['rating', 'Top rated']];
const COLOR_HEX = { black: '#1d1d1f', white: '#f7f7f5', gray: '#9a9aa0', beige: '#d9c8ad', brown: '#7b5234', blue: '#3a67c9', green: '#4f8a55', red: '#c0392b', pink: '#e8a0b4', yellow: '#e7c33f', orange: '#e07a2f', purple: '#8559b8', gold: '#c9a54a', silver: '#c7c9cc', multicolor: 'conic-gradient(#e74c3c, #f1c40f, #2ecc71, #3498db, #9b59b6, #e74c3c)' };
const BROWSE_PAGE = 12;

// ============================================================================ tiny helpers
const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 10);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
/** Escape any third-party text before it goes into HTML (text or attribute context). */
const esc = (s) => String(s ?? '').replace(/[&<>"'`]/g, (c) => ESC[c]);
const safeUrl = (u) => (/^https?:\/\//i.test(String(u ?? '')) ? String(u) : '#');
const safeHex = (h) => (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(String(h ?? '')) ? String(h) : '#CCCCCC');
const safeModelUrl = (u) => (/^(\/|https?:\/\/)/i.test(String(u ?? '')) ? String(u) : '');
/** All product/room images go through the backend proxy (hotlink protection, WebP → JPEG). */
const proxy = (u, w = 384) => (u ? `/api/img?u=${encodeURIComponent(u)}&w=${w}` : '');
const cap = (s) => { const t = String(s ?? ''); return t.charAt(0).toUpperCase() + t.slice(1); };
const shortTitle = (t) => String(t ?? '').split(/,\s| - | \| /)[0];

const fmtCache = new Map();
function money(n, currency = 'USD') {
  if (n == null || !Number.isFinite(Number(n))) return '';
  const v = Number(n);
  const cents = Math.abs(v % 1) > 0.001;
  const key = `${currency}|${cents}`;
  try {
    if (!fmtCache.has(key)) fmtCache.set(key, new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 }));
    return fmtCache.get(key).format(v);
  } catch {
    return `$${v.toFixed(cents ? 2 : 0)}`;
  }
}
const compact = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n));
function ago(ts) {
  const s = (Date.now() - Number(ts)) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
/** Approximate RGB of a black-body light source (for the lighting swatch). */
function kelvinToHex(k) {
  const t = Math.max(1000, Math.min(12000, Number(k) || 3500)) / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

/** Only touch the DOM when the markup actually changed (keeps scroll, focus and images stable). */
function setHTML(el, html) {
  if (!el) return false;
  if (el._html === html) return false;
  el.innerHTML = html;
  el._html = html;
  return true;
}

/** Keyed list reconciliation: reuse elements by key, update in place, keep order. */
function patchList(container, items, keyOf, update, create) {
  const existing = new Map();
  for (const child of [...container.children]) {
    if (child.dataset.key != null) existing.set(child.dataset.key, child);
    else child.remove();
  }
  const seen = new Set();
  let prev = null;
  for (const item of items) {
    const k = keyOf(item);
    if (seen.has(k)) continue;
    seen.add(k);
    let el = existing.get(k);
    if (!el) {
      el = create(item);
      el.dataset.key = k;
    }
    update(el, item);
    const want = prev ? prev.nextSibling : container.firstChild;
    if (want !== el) container.insertBefore(el, want);
    prev = el;
  }
  for (const [k, el] of existing) if (!seen.has(k)) el.remove();
}

// ============================================================================ icons (inline SVG, stroke = currentColor)
const ICONS = {
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  sparkles: '<path d="M11.2 3.6a.8.8 0 0 1 1.6 0l.9 3.3a3 3 0 0 0 2.2 2.2l3.3.9a.8.8 0 0 1 0 1.6l-3.3.9a3 3 0 0 0-2.2 2.2l-.9 3.3a.8.8 0 0 1-1.6 0l-.9-3.3a3 3 0 0 0-2.2-2.2L4.8 11.6a.8.8 0 0 1 0-1.6l3.3-.9a3 3 0 0 0 2.2-2.2z"/><path d="M19 17v4M17 19h4"/>',
  cube: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
  heart: '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  bag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18M16 10a4 4 0 0 1-8 0"/>',
  sofa: '<path d="M20 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v3"/><path d="M2 16a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v1.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5V11a2 2 0 0 0-4 0z"/><path d="M4 18v2M20 18v2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  arrowUp: '<path d="m5 12 7-7 7 7M12 19V5"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M19 10a7 7 0 0 1-14 0M12 17v5M8 22h8"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  arrowRight: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>',
  ruler: '<path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.4 2.4 0 0 1 0-3.4l2.6-2.6a2.4 2.4 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2M11.5 9.5l2-2M8.5 6.5l2-2M17.5 15.5l2-2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  copy: '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/>',
  headset: '<path d="M3 10a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v4.5a3 3 0 0 1-3 3h-2.6a2 2 0 0 1-1.6-.8l-.6-.8a1.5 1.5 0 0 0-2.4 0l-.6.8a2 2 0 0 1-1.6.8H6a3 3 0 0 1-3-3Z"/><path d="M3 11.5H1.5M22.5 11.5H21"/>',
  star: '<path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5L2.5 9.4l6.6-.9z"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  wifi: '<path d="M5 12.6a10 10 0 0 1 14 0M8.5 16.1a5 5 0 0 1 7 0M2 8.8a15 15 0 0 1 20 0M12 20h.01"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.4l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>',
  scale: '<path d="M21 3 3 21M21 3h-6M21 3v6M3 21h6M3 21v-6"/>',
};
const icon = (name, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;

// ============================================================================ state
const state = {
  route: { name: 'home' },
  health: null,
  photos: [], // { id, name, blob, upload?, thumb?, ready }
  photoQueue: Promise.resolve(),
  creating: false,
  session: null, // expanded session for the current route
  notFound: false,
  inflight: 0, // cart mutations in flight (poll results are ignored meanwhile)
  cartOrder: new Map(), // productId -> first-seen order, keeps cart rows stable
  openStores: new Set(), // expanded "Buy at" lists in the cart
  modal: null, // { kind, pid, token }
  lastStatus: null,
  catalog: null, // GET /api/catalog: size, vocab, shopping usage
  asking: null, // text of the in-flight assistant turn
  browseShown: BROWSE_PAGE, // how many browse results are rendered
  filtersOpen: false,
  focusId: null, // product the user last opened ("how much is this one?")
  rec: null, // { recorder, chunks, stream } while the mic is on
};

// ============================================================================ API
class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
async function api(path, { method = 'GET', body, signal } = {}) {
  const init = { method, signal, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new ApiError('Can’t reach the VRShop server. Check that you’re on the same Wi-Fi.', 0);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status);
  return data;
}

/** Multipart upload with progress (fetch can't report upload progress). */
function uploadSession(form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/sessions');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.upload.onload = () => onProgress(1);
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300 && data?.id) resolve(data);
      else reject(new ApiError(data?.error || `Upload failed (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('Upload failed. Check your connection to the VRShop server.', 0));
    xhr.ontimeout = () => reject(new ApiError('Upload timed out. Try fewer photos.', 0));
    xhr.timeout = 180000;
    xhr.send(form);
  });
}

// ============================================================================ product helpers
const product = (id) => state.session?.products?.[id] ?? null;
const cartQty = (id) => state.session?.cart?.find((c) => c.productId === id)?.qty ?? 0;
const cartCount = () => (state.session?.cart ?? []).reduce((n, c) => n + (Number(c.qty) || 0), 0);
const isBusy = (s) => s && (s.status === 'analyzing' || s.status === 'searching');
const modelPending = (p) => p?.model?.status === 'queued' || p?.model?.status === 'processing';
const hasPendingModels = (s) => Object.values(s?.products ?? {}).some(modelPending);
const imageOf = (p) => p?.imageUrl || p?.images?.[0] || '';

function priceLabel(p) {
  if (p.priceText) return p.priceText;
  if (p.price != null) return money(p.price, p.currency);
  return 'See price';
}

function dimsParts(d) {
  if (!d || !(Number(d.w) > 0)) return null;
  const vals = [d.w, d.d, d.h].map(Number);
  return {
    cm: vals.map((v) => Math.max(1, Math.round(v * 100))),
    inch: vals.map((v) => Math.max(1, Math.round(v * 39.3701))),
  };
}
const DIMS_SRC = { listing: 'from the listing', model: 'measured from the 3D model', estimated: 'estimated' };

function dimsHtml(p) {
  const d = dimsParts(p.dims);
  if (!d) return '';
  const approx = p.dimsSource === 'estimated' ? '≈ ' : '';
  const title = `Width × depth × height${p.dimsSource ? `, ${DIMS_SRC[p.dimsSource] ?? p.dimsSource}` : ''}`;
  return `<div class="card-dims" title="${esc(title)}">${icon('ruler')}<span>${approx}${d.cm.join(' × ')} cm</span><span class="in">${approx}${d.inch.join(' × ')} in</span></div>`;
}

function badge3d(p) {
  const m = p?.model ?? { status: 'none' };
  if (m.status === 'ready' && m.url) {
    if (m.kind === 'official') return `<span class="b3d b3d-official">${icon('cube')}IKEA 3D model</span>`;
    if (m.kind === 'generated') return `<span class="b3d b3d-ai">${icon('sparkles')}AI 3D model</span>`;
    return `<span class="b3d b3d-standin">${icon('cube')}Stand-in</span>`;
  }
  if (modelPending(p)) {
    const pct = Math.round((Number(m.progress) || 0) * 100);
    return `<span class="b3d b3d-busy"><span class="mini-spin"></span>Preparing 3D… ${pct}%</span>`;
  }
  return `<span class="b3d b3d-none">${icon('cube')}3D on demand</span>`;
}

const KIND_TEXT = {
  official: 'Official IKEA model: exact geometry, true scale.',
  generated: 'Generated from the product photo by AI, scaled to the real dimensions.',
  standin: 'Simple stand-in shaped and sized like the real item, so it still fits-checks at true scale in VR.',
};

// ============================================================================ toasts
const TOAST_ICON = { success: 'check', error: 'alert', warn: 'alert', info: 'info' };
function toast(message, { type = 'info', action, timeout = 3400 } = {}) {
  const box = $('#toasts');
  while (box.children.length >= 3) box.firstElementChild.remove();
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `${icon(TOAST_ICON[type] ?? 'info')}<span>${esc(message)}</span>${action ? `<a href="${esc(action.href)}">${esc(action.label)}</a>` : ''}`;
  box.appendChild(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
  const kill = () => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); };
  setTimeout(kill, type === 'error' ? Math.max(timeout, 5000) : timeout);
  el.querySelector('a')?.addEventListener('click', kill);
}

// ============================================================================ router
function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 's' && parts[1]) return { name: parts[2] === 'cart' ? 'cart' : 'session', id: decodeURIComponent(parts[1]) };
  return { name: 'home' };
}

function onRoute() {
  const prev = state.route;
  const r = parseRoute();
  state.route = r;
  if (state.modal) closeModal(true);

  if (r.name === 'home') {
    stopPolling();
    poll.id = null;
    viewHome();
  } else {
    if (!prev.id || prev.id !== r.id) {
      if (state.session?.id !== r.id) state.session = null;
      state.notFound = false;
      state.lastStatus = state.session?.status ?? null;
    }
    if (r.name === 'session') viewSession();
    else viewCart();
    startPolling(r.id);
    if (r.name === 'session') preloadModelViewer();
  }
  renderChrome();
  if (prev.name !== r.name || prev.id !== r.id) window.scrollTo(0, 0);
  app.classList.remove('view-enter');
  void app.offsetWidth;
  app.classList.add('view-enter');
}

function renderChrome() {
  const r = state.route;
  const s = state.session;
  const inSession = r.name !== 'home';
  document.body.classList.toggle('has-tabbar', inSession);
  const bar = $('#tabbar');
  bar.hidden = !inSession;
  if (inSession) {
    const id = encodeURIComponent(r.id);
    const room = bar.querySelector('[data-tab=room]');
    const cart = bar.querySelector('[data-tab=cart]');
    room.href = `#/s/${id}`;
    cart.href = `#/s/${id}/cart`;
    room.classList.toggle('active', r.name === 'session');
    cart.classList.toggle('active', r.name === 'cart');
    room.setAttribute('aria-current', r.name === 'session' ? 'page' : 'false');
    cart.setAttribute('aria-current', r.name === 'cart' ? 'page' : 'false');
    const n = cartCount();
    const badge = $('#cart-count');
    if (badge.textContent !== String(n)) {
      badge.textContent = String(n);
      badge.classList.remove('bump');
      void badge.offsetWidth;
      if (n > 0) badge.classList.add('bump');
    }
    badge.classList.toggle('zero', n === 0);
    cart.setAttribute('aria-label', `Cart (${n} item${n === 1 ? '' : 's'})`);
  }
  const right = $('#topbar-right');
  const code = inSession && r.id !== 'latest' ? r.id : s?.id;
  setHTML(right, inSession
    ? `${code ? `<span class="code-pill" title="Session code">Room <b>${esc(code)}</b></span>` : ''}<a class="btn btn-sm btn-secondary" href="#/" aria-label="Start a new room">${icon('plus')} New</a>`
    : '');
  const roomType = s?.room?.roomType;
  document.title = r.name === 'home' ? 'VRShop · Design your room in VR' : `${r.name === 'cart' ? 'Cart · ' : ''}${roomType ? cap(roomType) : 'Your room'} · VRShop`;
}

function renderAll() {
  if (state.route.name === 'session') renderSession();
  else if (state.route.name === 'cart') renderCart();
  renderChrome();
  renderModalFoot();
}

// ============================================================================ polling
const poll = { id: null, timer: 0, seq: 0, fails: 0, active: false };

function startPolling(id) {
  if (poll.active && poll.id === id) return;
  stopPolling();
  poll.id = id;
  poll.active = true;
  poll.fails = 0;
  const seq = ++poll.seq;
  pollLoop(seq);
}
function stopPolling() {
  poll.active = false;
  poll.seq++;
  clearTimeout(poll.timer);
}
function kickPoll() {
  if (!poll.id) return;
  const id = poll.id;
  stopPolling();
  startPolling(id);
}

async function pollLoop(seq) {
  const id = poll.id;
  const cur = state.session?.id === id ? state.session : null;
  // Product model progress doesn't bump session.updatedAt, so fetch the full session while models are being prepared.
  const useSince = cur && id !== 'latest' && !hasPendingModels(cur);
  try {
    const url = id === 'latest' ? '/api/sessions/latest' : `/api/sessions/${encodeURIComponent(id)}${useSince ? `?since=${cur.updatedAt}` : ''}`;
    const d = await api(url);
    if (seq !== poll.seq) return;
    poll.fails = 0;
    setOffline(false);
    if (id === 'latest' && d?.id) {
      state.session = d;
      state.lastStatus = d.status;
      location.replace(`#/s/${encodeURIComponent(d.id)}${state.route.name === 'cart' ? '/cart' : ''}`);
      return;
    }
    if (d && !d.unchanged && state.inflight === 0) applySession(d);
  } catch (e) {
    if (seq !== poll.seq) return;
    if (e.status === 404) {
      state.notFound = true;
      renderAll();
      stopPolling();
      return;
    }
    poll.fails++;
    if (poll.fails >= 2) setOffline(true);
  }
  if (seq !== poll.seq) return;
  const s = state.session;
  const delay = poll.fails ? Math.min(10000, 2000 * poll.fails) : isBusy(s) || !s ? 2000 : hasPendingModels(s) ? 2500 : 5000;
  poll.timer = setTimeout(() => pollLoop(seq), delay);
}

function setOffline(on) {
  const el = $('#offline');
  if (el.hidden === !on) return;
  el.hidden = !on;
}

function applySession(d) {
  if (!d?.id) return;
  if (state.route.name === 'home') return;
  if (d.id !== state.route.id) return;
  const prevStatus = state.lastStatus;
  state.session = d;
  state.notFound = false;
  (d.cart ?? []).forEach((c) => { if (!state.cartOrder.has(c.productId)) state.cartOrder.set(c.productId, state.cartOrder.size); });
  if (prevStatus && prevStatus !== 'ready' && d.status === 'ready') {
    const n = d.categories?.reduce((a, c) => a + c.productIds.length, 0) ?? 0;
    toast(`Your room is ready: ${n} real products across ${d.categories.length} categories.`, { type: 'success' });
  }
  state.lastStatus = d.status;
  renderAll();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (poll.active) { const id = poll.id; stopPolling(); poll.id = id; } }
  else if (poll.id && state.route.name !== 'home') startPolling(poll.id);
  else if (state.route.name === 'home') loadRecent();
});

// ============================================================================ HOME
function roomDiagram() {
  // Top-down room: camera spots in each corner + the doorway, looking in.
  return `<svg class="room-diagram" viewBox="0 0 132 96" aria-hidden="true">
    <path class="rd-cone" d="M16 16 L44 26 L26 44 Z"/><path class="rd-cone" d="M116 16 L88 26 L106 44 Z"/>
    <path class="rd-cone" d="M16 78 L26 52 L44 68 Z"/><path class="rd-cone" d="M116 78 L106 52 L88 68 Z"/>
    <path class="rd-cone" d="M66 84 L50 56 L82 56 Z"/>
    <path class="rd-wall" d="M54 88H12a6 6 0 0 1-6-6V14a6 6 0 0 1 6-6h108a6 6 0 0 1 6 6v68a6 6 0 0 1-6 6H78"/>
    <path class="rd-door" d="M54 88 A 24 24 0 0 1 78 88"/>
    <circle class="rd-cam" cx="16" cy="16" r="4"/><circle class="rd-cam" cx="116" cy="16" r="4"/>
    <circle class="rd-cam" cx="16" cy="78" r="4"/><circle class="rd-cam" cx="116" cy="78" r="4"/>
    <circle class="rd-cam" cx="66" cy="84" r="4"/>
  </svg>`;
}

function viewHome() {
  const draft = store.get('vrshop.draft', {});
  app.innerHTML = `
    <section class="hero">
      <span class="eyebrow">${icon('headset')} For Meta Quest · real products · true scale</span>
      <h1>Design your room <span class="grad nowrap">in VR</span></h1>
      <p class="lede">Snap your room, describe the vibe, and we’ll find real furniture from IKEA and other stores. Then walk around it, life-size, in your headset.</p>
      <ol class="how">
        <li>${icon('camera')}<div>Photograph<span>4–8 shots</span></div></li>
        <li>${icon('sparkles')}<div>Get picks<span>Real listings</span></div></li>
        <li>${icon('headset')}<div>Place in VR<span>True scale</span></div></li>
      </ol>
    </section>

    <section class="card" aria-labelledby="cap-title">
      <div class="card-head"><span class="step-num">1</span><div><h2 id="cap-title">Capture your room</h2><p class="muted">Take 4–8 photos: each wall, each corner, stand in the doorway.</p></div></div>
      <div class="capture-tip">
        ${roomDiagram()}
        <ul>
          <li>${icon('check')}<span><b>Each wall</b>, straight on</span></li>
          <li>${icon('check')}<span><b>Each corner</b>, wide</span></li>
          <li>${icon('check')}<span><b>The doorway</b>, looking in</span></li>
        </ul>
      </div>
      <div class="btn-row">
        <button type="button" class="btn btn-primary btn-tile" data-action="pick-camera">${icon('camera')} Take photo</button>
        <button type="button" class="btn btn-secondary btn-tile" data-action="pick-library">${icon('image')} Choose photos</button>
      </div>
      <input id="in-camera" class="sr-only" type="file" accept="image/*" capture="environment" tabindex="-1" aria-hidden="true">
      <input id="in-library" class="sr-only" type="file" accept="image/*" multiple tabindex="-1" aria-hidden="true">
      <div id="shots" class="shots"></div>
    </section>

    <section class="card" aria-labelledby="vibe-title">
      <div class="card-head"><span class="step-num">2</span><div><h2 id="vibe-title">Set the vibe</h2><p class="muted">Our designer uses this to pick styles, colors and sizes.</p></div></div>
      <label class="field-label" for="prompt">What do you want this room to feel like?</label>
      <textarea id="prompt" class="input" rows="3" maxlength="600" placeholder="e.g. Warm and calm, lots of plants, a spot to read" enterkeyhint="done">${esc(draft.prompt ?? '')}</textarea>
      <div class="chips scroll" role="group" aria-label="Example ideas">
        ${PROMPT_EXAMPLES.map((t) => `<button type="button" class="chip" data-action="prompt-chip" data-value="${esc(t)}">${esc(t)}</button>`).join('')}
      </div>
      <div class="field-gap"></div>
      <label class="field-label" for="budget">Budget</label>
      <div class="money-input"><span>$</span><input id="budget" class="input" type="number" inputmode="numeric" min="0" step="50" placeholder="1,500" value="${esc(draft.budget ?? '')}"></div>
      <div class="chips" role="group" aria-label="Budget presets">
        ${BUDGETS.map((b) => `<button type="button" class="chip" data-action="budget-chip" data-value="${b}">${money(b)}</button>`).join('')}
      </div>
    </section>

    <div class="cta">
      <button type="button" class="btn btn-primary btn-xl" id="design-btn" data-action="design"><span class="fill"></span><span class="lbl">${icon('sparkles')} Design my room</span></button>
      <p class="cta-note" id="cta-note"></p>
      <button type="button" class="linkish" data-action="demo">Try a demo room (no photos)</button>
    </div>

    <div id="lan-hint"></div>

    <section aria-labelledby="recent-title">
      <h2 class="section-title" id="recent-title">Recent rooms</h2>
      <div id="recent"></div>
    </section>

    <footer class="caps" id="caps"></footer>
  `;
  $('#in-camera').addEventListener('change', onFilesPicked);
  $('#in-library').addEventListener('change', onFilesPicked);
  $('#prompt').addEventListener('input', () => { saveDraft(); syncChips(); updateCta(); });
  $('#budget').addEventListener('input', () => { saveDraft(); syncChips(); });
  renderShots();
  syncChips();
  updateCta();
  renderCaps();
  loadRecent();
}

function saveDraft() {
  store.set('vrshop.draft', { prompt: $('#prompt')?.value ?? '', budget: $('#budget')?.value ?? '' });
}
function syncChips() {
  const p = $('#prompt')?.value.trim().toLowerCase();
  const b = Number($('#budget')?.value);
  document.querySelectorAll('[data-action=prompt-chip]').forEach((c) => c.classList.toggle('active', c.dataset.value.toLowerCase() === p));
  document.querySelectorAll('[data-action=budget-chip]').forEach((c) => c.classList.toggle('active', Number(c.dataset.value) === b));
}
function updateCta() {
  const note = $('#cta-note');
  if (!note) return;
  const n = state.photos.length;
  const hasPrompt = !!$('#prompt')?.value.trim();
  note.textContent = n ? `${n} photo${n === 1 ? '' : 's'} ready${hasPrompt ? '' : ' · add a vibe for better picks'}` : hasPrompt ? 'No photos? We’ll plan from your description.' : '';
}

function onFilesPicked(e) {
  const input = e.target;
  const files = [...(input.files ?? [])];
  input.value = ''; // allow picking the same file / tapping "Take photo" again
  if (files.length) addFiles(files);
}

function addFiles(files) {
  const images = files.filter((f) => /^image\//.test(f.type) || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name));
  if (images.length < files.length) toast('Some files weren’t images and were skipped.', { type: 'warn' });
  const room = MAX_PHOTOS - state.photos.length;
  if (room <= 0) return toast(`That’s the max: ${MAX_PHOTOS} photos.`, { type: 'warn' });
  if (images.length > room) toast(`Up to ${MAX_PHOTOS} photos. Kept the first ${room}.`, { type: 'warn' });
  for (const f of images.slice(0, room)) {
    const item = { id: uid(), name: f.name, blob: f, upload: null, thumb: null, ready: false };
    state.photos.push(item);
    state.photoQueue = state.photoQueue.then(() => processPhoto(item)).then(renderShots, renderShots);
  }
  renderShots();
  updateCta();
}

/** Downscale on-device (EXIF-rotated by the browser) so uploads are fast over Wi-Fi and thumbnails are cheap. */
async function processPhoto(item) {
  if (!state.photos.includes(item)) return;
  let src = '';
  try {
    src = URL.createObjectURL(item.blob);
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    await img.decode();
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) throw new Error('empty image');
    const big = await drawToBlob(img, w, h, 1600, 0.86);
    const small = await drawToBlob(img, w, h, 360, 0.8);
    if (big && big.size < item.blob.size) item.upload = big;
    if (small) item.thumb = URL.createObjectURL(small);
  } catch {
    // Browser can't decode it (e.g. HEIC on desktop Chrome): upload the original; the server converts it.
  } finally {
    if (src) URL.revokeObjectURL(src);
    item.ready = true;
    if (!state.photos.includes(item) && item.thumb) URL.revokeObjectURL(item.thumb);
  }
}
function drawToBlob(img, w, h, max, quality) {
  const s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return new Promise((resolve) => c.toBlob((b) => { c.width = c.height = 0; resolve(b); }, 'image/jpeg', quality));
}

function removePhoto(id) {
  const i = state.photos.findIndex((p) => p.id === id);
  if (i < 0) return;
  const [p] = state.photos.splice(i, 1);
  if (p.thumb) URL.revokeObjectURL(p.thumb);
  renderShots();
  updateCta();
}

function renderShots() {
  const el = $('#shots');
  if (!el) return;
  const n = state.photos.length;
  if (!n) { el.innerHTML = ''; return; }
  const tiles = state.photos.map((p, i) => `
    <div class="shot ${p.ready ? '' : 'loading'}">
      ${p.thumb ? `<img src="${esc(p.thumb)}" alt="Room photo ${i + 1}">` : `<span class="shot-ph">${icon('image')}</span>`}
      <button type="button" class="shot-x" data-action="remove-photo" data-id="${esc(p.id)}" aria-label="Remove photo ${i + 1}">${icon('x')}</button>
    </div>`).join('');
  const add = n < MAX_PHOTOS ? `<button type="button" class="shot shot-add" data-action="pick-camera" aria-label="Take another photo">${icon('plus')}</button>` : '';
  const good = n >= 4;
  const msg = n < 4 ? `${n} of 4–8 · add ${4 - n} more for best results` : n <= 8 ? `${n} photos · great coverage` : `${n} photos · plenty (max ${MAX_PHOTOS})`;
  const segs = Array.from({ length: 8 }, (_, i) => `<i class="${i < n ? `on${good ? ' good' : ''}` : ''}"></i>`).join('');
  el.innerHTML = `<div class="shots-grid">${tiles}${add}</div>
    <div class="coverage ${good ? 'good' : ''}"><span class="segs" aria-hidden="true">${segs}</span><span>${good ? icon('check') + ' ' : ''}${esc(msg)}</span></div>`;
}

function setDesignBtn(label, busy, frac = 0) {
  const b = $('#design-btn');
  if (!b) return;
  b.classList.toggle('is-busy', busy);
  b.setAttribute('aria-busy', String(busy));
  b.querySelector('.lbl').innerHTML = busy ? `<span class="mini-spin"></span> ${esc(label)}` : `${icon('sparkles')} ${esc(label)}`;
  b.querySelector('.fill').style.width = busy ? `${Math.round(frac * 100)}%` : '0';
}

async function design() {
  if (state.creating) return;
  const prompt = $('#prompt').value.trim();
  const budget = Number($('#budget').value) || 0;
  if (!state.photos.length && !prompt) {
    toast('Add a few photos or describe what you want first.', { type: 'warn' });
    $('#prompt').focus();
    return;
  }
  state.creating = true;
  setDesignBtn('Preparing photos…', true, 0.02);
  try {
    await state.photoQueue;
    const fd = new FormData();
    state.photos.forEach((p, i) => {
      if (p.upload) fd.append('photos', p.upload, `room-${i + 1}.jpg`);
      else fd.append('photos', p.blob, p.name || `room-${i + 1}.jpg`);
    });
    fd.append('prompt', prompt);
    if (budget > 0) fd.append('budget', String(budget));
    const s = await uploadSession(fd, (f) => setDesignBtn(f < 1 ? `Uploading ${Math.round(f * 100)}%` : 'Starting analysis…', true, f));
    state.photos.forEach((p) => p.thumb && URL.revokeObjectURL(p.thumb));
    state.photos = [];
    openSession(s);
  } catch (e) {
    toast(e.message || 'Something went wrong.', { type: 'error' });
  } finally {
    state.creating = false;
    setDesignBtn('Design my room', false);
  }
}

async function demo() {
  if (state.creating) return;
  const prompt = $('#prompt')?.value.trim();
  const budget = Number($('#budget')?.value) || 0;
  state.creating = true;
  const btn = document.querySelector('[data-action=demo]');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="mini-spin"></span> Creating demo room…'; }
  try {
    const body = {};
    if (prompt) body.prompt = prompt;
    if (budget > 0) body.budget = budget;
    openSession(await api('/api/sessions/demo', { method: 'POST', body }));
  } catch (e) {
    toast(e.message, { type: 'error' });
    if (btn) { btn.disabled = false; btn.textContent = 'Try a demo room (no photos)'; }
  } finally {
    state.creating = false;
  }
}

function openSession(s) {
  state.session = s;
  state.lastStatus = s.status;
  state.notFound = false;
  location.hash = `#/s/${encodeURIComponent(s.id)}`;
}

const STATUS_PILL = {
  ready: '<span class="pill pill-success">Ready</span>',
  analyzing: '<span class="pill pill-accent"><span class="mini-spin"></span>Analyzing</span>',
  searching: '<span class="pill pill-accent"><span class="mini-spin"></span>Shopping</span>',
  error: '<span class="pill pill-danger">Error</span>',
};

async function loadRecent() {
  const el = $('#recent');
  if (!el) return;
  if (!el.children.length) el.innerHTML = `<div class="card recent-list">${[0, 1].map(() => `<div class="recent-item"><div class="recent-thumb skel"></div><div class="recent-main"><div class="skel skel-line" style="width:40%;margin:0"></div><div class="skel skel-line" style="width:75%"></div></div></div>`).join('')}</div>`;
  try {
    const list = await api('/api/sessions');
    if (state.route.name !== 'home' || !$('#recent')) return;
    if (!Array.isArray(list) || !list.length) {
      setHTML(el, `<div class="card empty"><div class="empty-icon">${icon('sofa')}</div><h2>No rooms yet</h2><p>Your designed rooms will show up here, and the most recent one loads automatically in the headset.</p></div>`);
      return;
    }
    setHTML(el, `<div class="card recent-list">${list.map((r) => {
      const photo = r.photos?.[0];
      const title = r.roomType ? cap(r.roomType) : r.status === 'error' ? 'Unfinished room' : 'Designing…';
      return `<a class="recent-item" href="#/s/${encodeURIComponent(r.id)}">
        <div class="recent-thumb">${photo ? `<img src="${esc(proxy(photo, 160))}" alt="" loading="lazy">` : icon('sofa')}</div>
        <div class="recent-main">
          <div class="recent-title">${esc(title)}</div>
          <div class="recent-sub">${r.prompt ? `“${esc(r.prompt)}”` : `${r.photos?.length ? 'From photos' : 'No description'}`}</div>
          <div class="recent-foot">${STATUS_PILL[r.status] ?? ''}<span>${esc(ago(r.createdAt))}</span><span class="faint">· ${esc(r.id)}</span></div>
        </div>
        ${icon('chevronRight', 'recent-chev')}
      </a>`;
    }).join('')}</div>`);
  } catch (e) {
    setHTML(el, `<div class="card empty"><div class="empty-icon">${icon('wifi')}</div><h2>Can’t load recent rooms</h2><p>${esc(e.message)}</p><button type="button" class="btn btn-secondary" data-action="retry-recent">${icon('refresh')} Try again</button></div>`);
  }
}

async function loadHealth() {
  try { state.health = await api('/api/health'); } catch { state.health = null; }
  renderCaps();
}

function renderCaps() {
  const el = $('#caps');
  if (!el) return;
  const h = state.health;
  if (!h) { el.innerHTML = ''; return; }
  const c = h.capabilities ?? {};
  const stores = ['IKEA', c.serpapi ? 'Google Shopping' : null].filter(Boolean).join(' + ');
  const gen = c.generator && c.generator !== 'none' ? c.generator : null;
  el.innerHTML = `
    <span><i class="dot ${c.openai ? 'on' : ''}"></i>AI: ${c.openai ? 'OpenAI ✓' : 'basic planner'}</span>
    <span><i class="dot on"></i>Stores: ${esc(stores)}</span>
    <span><i class="dot ${gen ? 'on' : ''}"></i>3D: ${gen ? `IKEA + AI (${esc(gen)})` : 'IKEA models + stand-ins'}</span>`;
  // Opened on the laptop via localhost? Tell people how to open it on the phone.
  const lan = $('#lan-hint');
  if (lan && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) && /^https?:\/\//.test(h.baseUrl ?? '') && !/localhost/.test(h.baseUrl)) {
    setHTML(lan, `<div class="card lan-card">${icon('wifi')}<div><div class="muted" style="font-size:14px">Open this on your iPhone (same Wi-Fi)</div><code>${esc(h.baseUrl)}</code></div></div>`);
  }
}

// ============================================================================ SESSION
function viewSession() {
  app.innerHTML = `
    <div id="s-status"></div>
    <div id="s-room"></div>
    <div id="s-photos"></div>
    <div id="s-quest"></div>
    <div id="s-placed"></div>
    <section class="card ask" aria-label="Shopping assistant">
      <div id="chat" class="chat" aria-live="polite"></div>
      <form id="ask-form" autocomplete="off">
        <div class="ask-field">
          ${icon('sparkles')}
          <input id="ask-input" name="q" type="text" enterkeyhint="send" maxlength="300" placeholder="Ask or filter: “black leather sofa”…" aria-label="Ask the shopping assistant">
          <button class="ask-mic" type="button" data-action="mic" aria-label="Speak" hidden>${icon('mic')}</button>
          <button class="ask-go" type="submit" aria-label="Send">${icon('arrowUp')}</button>
        </div>
      </form>
      <div class="chips scroll">${ASK_EXAMPLES.map((t) => `<button type="button" class="chip" data-action="ask-example" data-value="${esc(t)}">${esc(t)}</button>`).join('')}</div>
    </section>
    <section id="s-browse" class="browse" aria-label="Browse the catalog"></section>
    <div id="s-cats" class="cats"></div>
    <div id="s-more"></div>
  `;
  $('#ask-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submitAsk($('#ask-input').value.trim());
  });
  // Voice needs a secure context (https or localhost) on iPhone; otherwise the keyboard's dictation key still works.
  if (window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder) $('.ask-mic').hidden = false;
  state.browseShown = BROWSE_PAGE;
  loadCatalog();
  renderSession();
}

function renderSession() {
  if (state.route.name !== 'session' || !$('#s-cats')) return;
  if (state.notFound) return renderNotFound();
  const s = state.session?.id === state.route.id ? state.session : null;
  renderStatus($('#s-status'), s);
  setHTML($('#s-room'), s?.room ? roomHtml(s) : roomSkeleton(s));
  setHTML($('#s-photos'), s?.photos?.length ? photosHtml(s) : '');
  setHTML($('#s-quest'), questHtml(s?.id ?? (state.route.id !== 'latest' ? state.route.id : '')));
  setHTML($('#s-placed'), s ? placedHtml(s) : '');
  const form = $('#ask-form');
  if (form) {
    const busy = !!state.asking;
    form.querySelector('input').disabled = busy;
    form.querySelector('.ask-go').disabled = busy;
    form.querySelector('.ask-go').innerHTML = busy ? '<span class="mini-spin"></span>' : icon('arrowUp');
    const mic = form.querySelector('.ask-mic');
    mic.classList.toggle('on', !!state.rec);
    mic.disabled = busy && !state.rec;
  }
  renderChat(s);
  renderBrowse(s);
  renderCats(s);
}

function renderNotFound() {
  stopPolling();
  app._html = null;
  app.innerHTML = (`<section class="card empty" style="margin-top:24px"><div class="empty-icon">${icon('search')}</div><h2>Room not found</h2><p>We couldn’t find room <b>${esc(state.route.id)}</b>. It may have been created on another server.</p><a class="btn btn-primary" href="#/">Design a new room</a></section>`);
  renderChrome();
}

function renderStatus(el, s) {
  const mode = !s ? 'none' : s.status === 'error' ? 'error' : isBusy(s) ? 'progress' : 'none';
  if (mode === 'none') { el.innerHTML = ''; el._html = null; el._mode = mode; return; }
  if (mode === 'error') {
    if (el._mode !== 'error') el._html = null;
    el._mode = mode;
    setHTML(el, `<section class="card status-error" role="alert">${icon('alert')}<div><h2>We hit a snag</h2><p>${esc(s.error || s.stage || 'Something went wrong while designing this room.')}</p>
      ${s.categories?.length ? '<p class="muted" style="margin-top:6px">Picks found so far are below.</p>' : ''}
      <a class="btn btn-primary" href="#/">${icon('plus')} Start a new room</a></div></section>`);
    return;
  }
  if (el._mode !== 'progress') {
    el._mode = 'progress';
    el._html = null;
    el.innerHTML = `<section class="card progress-card" aria-live="polite">
      <div class="progress-top"><span class="pulse"></span><div><h2 data-f="title"></h2><p class="muted" data-f="stage"></p></div><span class="pct" data-f="pct"></span></div>
      <div class="bar live"><i data-f="bar" style="width:4%"></i></div>
      <ol class="progress-steps" data-f="steps"></ol></section>`;
  }
  const recs = s.room?.recommendations?.length ?? 0;
  const found = (s.categories ?? []).filter((c) => c.origin === 'analysis').length;
  const pct = s.status === 'analyzing' ? 12 : Math.min(95, 30 + Math.round(65 * (recs ? found / recs : 0)));
  const f = (k) => el.querySelector(`[data-f=${k}]`);
  f('title').textContent = s.status === 'analyzing' ? (s.photos?.length ? 'Looking at your room' : 'Planning your room') : 'Finding real products';
  f('stage').textContent = s.stage || '';
  f('pct').textContent = `${pct}%`;
  requestAnimationFrame(() => { const b = f('bar'); if (b) b.style.width = `${pct}%`; });
  const step = (label, st) => `<li class="${st}">${st === 'done' ? icon('check') : st === 'active' ? '<span class="mini-spin"></span>' : icon('minus')}${label}</li>`;
  setHTML(f('steps'), [
    step(s.photos?.length ? 'Analyze photos' : 'Plan the room', s.status === 'analyzing' ? 'active' : 'done'),
    step(recs ? `Shop ${found}/${recs}` : 'Shop real stores', s.status === 'searching' ? 'active' : ''),
    step('Prepare 3D', ''),
  ].join(''));
}

function roomSkeleton(s) {
  return `<section class="card room-card" aria-busy="true">
    <div class="skel" style="height:12px;width:30%"></div>
    <div class="skel skel-title" style="margin-top:12px"></div>
    <div class="skel skel-line" style="width:92%;margin-top:16px"></div>
    <div class="skel skel-line" style="width:70%"></div>
    ${s?.prompt ? `<blockquote class="wish">“${esc(s.prompt)}”</blockquote>` : ''}
    <div style="display:flex;gap:10px;margin-top:18px">${[0, 1, 2, 3].map(() => '<div class="skel" style="width:46px;height:46px;border-radius:50%"></div>').join('')}</div>
  </section>`;
}

function roomHtml(s) {
  const r = s.room;
  const products = Object.values(s.products ?? {});
  const shown = new Set((s.categories ?? []).flatMap((c) => c.productIds));
  const ready3d = products.filter((p) => shown.has(p.id) && p.model?.status === 'ready').length;
  const tags = (r.styleTags ?? []).map((t) => `<span class="chip chip-static">${esc(t)}</span>`).join('');
  const palette = (r.palette ?? []).map((c) => `<li><span class="swatch" style="background:${safeHex(c.hex)}"></span><span class="sw-name">${esc(c.name)}</span><span class="sw-hex">${esc(String(c.hex ?? '').toUpperCase())}</span></li>`).join('');
  const L = r.lighting ?? {};
  const kHex = kelvinToHex(L.kelvin);
  const spotted = (r.existingFurniture ?? []).slice(0, 8);
  const sourcePill = r.source === 'openai'
    ? `<span class="pill pill-accent">${icon('sparkles')} AI analysis</span>`
    : `<span class="pill" title="The server has no AI key, so this plan is based on your description only.">Quick plan</span>`;
  return `<section class="card room-card">
    <div class="room-top"><div><div class="eyebrow-sm">${s.photos?.length ? `From ${s.photos.length} photo${s.photos.length === 1 ? '' : 's'}` : 'Your room'}</div><h1>${esc(cap(r.roomType || 'Your room'))}</h1></div>${sourcePill}</div>
    ${r.summary ? `<p class="room-summary">${esc(r.summary)}</p>` : ''}
    ${s.prompt && !String(r.summary ?? '').includes(s.prompt) ? `<blockquote class="wish">“${esc(s.prompt)}”</blockquote>` : ''}
    ${tags ? `<div class="chips" aria-label="Style">${tags}</div>` : ''}
    ${palette ? `<div class="room-section"><h3 class="mini-title">Palette</h3><ul class="palette">${palette}</ul></div>` : ''}
    ${L.mood ? `<div class="room-section"><h3 class="mini-title">Lighting</h3><div class="light-row"><span class="kelvin" style="background:${kHex};--glow:${kHex}">${icon('sun')}</span><div><b>${esc(cap(L.mood))} light</b><div class="muted">${Number(L.kelvin) ? `${Math.round(L.kelvin)} K` : ''}${L.brightness != null ? ` · ${Math.round(Number(L.brightness) * 100)}% brightness` : ''}</div></div></div></div>` : ''}
    ${spotted.length ? `<div class="room-section"><h3 class="mini-title">Already in the room</h3><div class="chips">${spotted.map((f) => `<span class="chip chip-static" title="${esc(f.location)}">${esc(f.name)}</span>`).join('')}</div></div>` : ''}
    <div class="room-stats">
      <span class="stat"><b>${s.categories?.length ?? 0}</b> categories</span>
      <span class="stat"><b>${shown.size}</b> products</span>
      <span class="stat"><b>${ready3d}</b> ready in 3D</span>
      ${s.budget ? `<span class="stat">Budget <b>${money(s.budget)}</b></span>` : ''}
    </div>
  </section>`;
}

function photosHtml(s) {
  return `<section><h3 class="mini-title">Your photos <span class="faint">${s.photos.length}</span></h3><div class="hscroll">${s.photos.map((u, i) =>
    `<button type="button" class="photo-thumb" data-action="open-photo" data-src="${esc(u)}" aria-label="Open photo ${i + 1}"><img src="${esc(proxy(u, 240))}" alt="" loading="lazy"></button>`).join('')}</div></section>`;
}

function questHtml(id) {
  return `<section class="card quest" aria-labelledby="quest-title">
    <div class="quest-row">
      <div class="quest-art">${icon('headset')}</div>
      <div><h2 id="quest-title">Now put on your Quest</h2>
      <p>Open VRShop in the headset. It loads your latest room automatically, so you can walk around every pick at true scale.</p></div>
    </div>
    ${id ? `<div class="quest-code"><div><small>Session code</small><strong>${esc(id)}</strong></div><button type="button" class="btn btn-glass" data-action="copy-code" data-code="${esc(id)}">${icon('copy')} Copy</button></div>` : ''}
    <div class="quest-steps"><span>${icon('hand')} Grab & place</span><span>${icon('scale')} Real size</span><span>${icon('heart')} Add to cart in VR</span></div>
  </section>`;
}

function placedHtml(s) {
  const items = (s.placements ?? []).map((pl) => ({ pl, p: s.products?.[pl.productId] })).filter((x) => x.p);
  if (!items.length) return '';
  return `<section class="card placed">
    <div class="placed-head"><span class="live-dot"></span><div><h3>In your room</h3><p class="muted">${items.length} item${items.length === 1 ? '' : 's'} placed in the headset</p></div></div>
    <div class="hscroll">${items.map(({ pl, p }) => `<button type="button" class="placed-item" data-action="view-3d" data-id="${esc(p.id)}">
      <div class="ph-img">${imageOf(p) ? `<img src="${esc(proxy(imageOf(p), 256))}" alt="" loading="lazy" data-fallback>` : `<div class="ph">${icon('cube')}</div>`}</div>
      <span class="t">${esc(shortTitle(p.title))}</span><span class="r">${esc(pl.reason || priceLabel(p))}</span></button>`).join('')}</div>
  </section>`;
}

function skeletonRows(n, label) {
  return `<div class="cats">${Array.from({ length: n }, (_, i) => `<section class="cat" aria-busy="true">
    <div class="cat-head">${i === 0 && label ? `<div class="cat-title"><h2 class="faint" style="font-size:16px;display:flex;gap:8px;align-items:center"><span class="mini-spin"></span>${esc(label)}</h2></div>` : '<div class="skel" style="height:22px;width:40%"></div>'}<div class="skel skel-line" style="width:70%"></div></div>
    <div class="row">${[0, 1, 2].map(() => '<div class="skel skel-card"></div>').join('')}</div></section>`).join('')}</div>`;
}

function catKey(c) {
  return `${c.origin === 'analysis' ? 'a' : 'q'}:${c.category}`;
}

function renderCats(s) {
  const el = $('#s-cats');
  const more = $('#s-more');
  const busy = !s || isBusy(s);
  const cats = s?.categories ?? [];
  if (!cats.length) {
    el.replaceChildren();
    if (busy) setHTML(more, skeletonRows(2));
    else if (s?.status === 'error') setHTML(more, '');
    else setHTML(more, `<div class="card empty"><div class="empty-icon">${icon('search')}</div><h2>No picks yet</h2><p>Ask for something above, like “a cozy armchair under $300”.</p></div>`);
    return;
  }
  const cart = new Set((s.cart ?? []).map((c) => c.productId));
  patchList(el, cats, catKey, (sec, c) => updateCat(sec, c, s, cart), createCat);
  const recs = s.room?.recommendations?.length ?? 0;
  const found = cats.filter((c) => c.origin === 'analysis').length;
  setHTML(more, busy ? skeletonRows(1, recs ? `Finding more… ${found}/${recs}` : 'Finding more…') : '');
}

function createCat() {
  const sec = document.createElement('section');
  sec.className = 'cat';
  sec.innerHTML = '<div class="cat-head"></div><div class="row" role="list"></div>';
  return sec;
}

function updateCat(sec, c, s, cart) {
  const ids = c.productIds.filter((id) => s.products?.[id]);
  const asked = c.origin !== 'analysis';
  setHTML(sec.firstElementChild, `<div class="cat-title"><h2>${esc(c.label || cap(String(c.category).replace(/_/g, ' ')))}</h2>${asked ? `<span class="pill pill-accent">${icon('sparkles')} You asked</span>` : ''}<span class="cat-count">${ids.length}</span>
    <div class="row-nav"><button type="button" class="icon-btn" data-action="scroll-row" data-dir="-1" aria-label="Scroll left">${icon('chevronLeft')}</button><button type="button" class="icon-btn" data-action="scroll-row" data-dir="1" aria-label="Scroll right">${icon('chevronRight')}</button></div></div>
    ${c.why ? `<p class="cat-why">${esc(c.why)}</p>` : ''}`);
  const row = sec.lastElementChild;
  if (!ids.length) {
    setHTML(row, `<div class="inline-empty">No matches at these stores yet. Try asking in different words above.</div>`);
    return;
  }
  if (row._html != null) { row.replaceChildren(); row._html = null; }
  patchList(row, ids, (id) => id, (card, id) => updateCard(card, s.products[id], cart.has(id)), createCard);
}

function createCard() {
  const a = document.createElement('article');
  a.className = 'product';
  a.setAttribute('role', 'listitem');
  a.innerHTML = '<div class="card-media" data-action="view-3d"><div class="media-img"></div><div class="media-badge"></div></div><div class="card-body"></div>';
  return a;
}

function updateCard(card, p, inCart) {
  const media = card.firstElementChild;
  media.dataset.id = p.id;
  media.setAttribute('aria-label', `View ${p.title} in 3D`);
  const img = imageOf(p);
  setHTML(media.firstElementChild, img ? `<img src="${esc(proxy(img, 480))}" alt="${esc(p.title)}" loading="lazy" decoding="async" data-fallback>` : `<div class="ph">${icon('image')}</div>`);
  setHTML(media.lastElementChild, badge3d(p));
  setHTML(card.lastElementChild, `
    <div class="card-store">${esc(p.store || (p.source === 'ikea' ? 'IKEA' : 'Online store'))}</div>
    <h3 class="card-title" title="${esc(p.title)}">${esc(p.title)}</h3>
    <div class="card-meta"><span class="price">${esc(priceLabel(p))}</span>${Number(p.rating) ? `<span class="rating">${icon('star', 'i-fill')}${Number(p.rating).toFixed(1)}${Number(p.reviews) ? ` <span class="faint">(${compact(Number(p.reviews))})</span>` : ''}</span>` : ''}</div>
    ${dimsHtml(p)}
    ${p.why ? `<p class="card-why">${icon('sparkles')}<span>${esc(p.why)}</span></p>` : ''}
    <div class="card-actions">
      <button type="button" class="btn btn-sm btn-soft btn-cart ${inCart ? 'in' : ''}" data-action="toggle-cart" data-id="${esc(p.id)}" aria-pressed="${inCart}">${icon('heart', inCart ? 'i-fill' : '')}${inCart ? 'In cart' : 'Add to cart'}</button>
      <div class="btn-pair">
        <button type="button" class="btn btn-sm btn-secondary" data-action="view-3d" data-id="${esc(p.id)}">${icon('cube')}<span class="lbl-long">View in </span>3D</button>
        <a class="btn btn-sm btn-secondary" href="${esc(safeUrl(p.productUrl))}" target="_blank" rel="noopener noreferrer" aria-label="Open ${esc(p.store || 'store')} page">Store ${icon('external')}</a>
      </div>
    </div>`);
}

// ============================================================================ ASSISTANT + BROWSE
async function loadCatalog() {
  try { state.catalog = await api('/api/catalog'); } catch { state.catalog = null; }
  if (state.route.name === 'session') renderSession();
}

function renderChat(s) {
  const el = $('#chat');
  if (!el) return;
  const turns = (s?.chat ?? []).slice(-4);
  const pending = state.asking ? [{ role: 'user', text: state.asking }, { role: 'assistant', text: '…', pending: true }] : [];
  const all = [...turns, ...pending].slice(-4);
  if (!all.length) {
    const n = state.catalog?.total;
    setHTML(el, `<p class="chat-intro">${icon('sparkles')}<span>Tell me what you’re after — “black leather sofa”, “under $800”, “what’s the cheapest?”, “add the second one”. ${n ? `I’ll search ${n.toLocaleString('en-US')} real pieces.` : ''}</span></p>`);
    return;
  }
  setHTML(el, all.map((t) => `<div class="bubble ${t.role === 'user' ? 'me' : 'ai'}${t.pending ? ' pending' : ''}">${t.pending ? '<span class="mini-spin"></span>' : esc(t.text)}</div>`).join(''));
}

const facetLabel = (v) => cap(String(v).replace(/_/g, ' '));
const catLabel = (key) => state.catalog?.vocab?.categories?.find((c) => c.key === key)?.label ?? facetLabel(key);

function filterChips(f) {
  const chips = [];
  if (f.category) chips.push(['category', null, catLabel(f.category)]);
  for (const c of f.colors ?? []) chips.push(['colors', c, cap(c)]);
  for (const m of f.materials ?? []) chips.push(['materials', m, cap(m)]);
  for (const st of f.styles ?? []) chips.push(['styles', st, cap(st)]);
  for (const k of f.keywords ?? []) chips.push(['keywords', k, `“${k}”`]);
  for (const st of f.stores ?? []) chips.push(['stores', st, st]);
  if (f.minPrice || f.maxPrice) chips.push(['price', null, f.minPrice && f.maxPrice ? `${money(f.minPrice)}–${money(f.maxPrice)}` : f.maxPrice ? `Under ${money(f.maxPrice)}` : `${money(f.minPrice)}+`]);
  if (f.minRating) chips.push(['minRating', null, `${f.minRating}★+`]);
  if (f.maxWidthM || f.maxDepthM || f.maxHeightM) chips.push(['size', null, 'Size limit']);
  if (f.only3d) chips.push(['only3d', null, 'Official 3D']);
  return chips;
}

function renderBrowse(s) {
  const el = $('#s-browse');
  if (!el) return;
  const b = s?.browse;
  const f = b?.filters ?? {};
  const cat = state.catalog;
  const facets = b?.facets;
  const chips = filterChips(f);
  const head = b
    ? `<h2>${b.total.toLocaleString('en-US')} ${b.total === 1 ? 'match' : 'matches'}</h2>${b.priceRange ? `<span class="faint">${money(b.priceRange.min)} – ${money(b.priceRange.max)}</span>` : ''}`
    : `<h2>Browse the catalog</h2>${cat?.total ? `<span class="faint">${cat.total.toLocaleString('en-US')} pieces · ${cat.stores} store${cat.stores === 1 ? '' : 's'}</span>` : ''}`;

  const catOptions = (cat?.vocab?.categories ?? []).map((c) => `<option value="${esc(c.key)}" ${f.category === c.key ? 'selected' : ''}>${esc(c.label)}</option>`).join('');
  const pricePreset = PRICE_PRESETS.findIndex(([lo, hi]) => (lo || 0) === (f.minPrice || 0) && (hi || 0) === (f.maxPrice || 0));
  const facetRow = (kind, items) => (items?.length ? `<div class="facet"><h3 class="mini-title">${kind}</h3><div class="chips">${items.join('')}</div></div>` : '');
  const colorChips = (facets?.colors ?? []).slice(0, 12).map((x) => `<button type="button" class="chip chip-color ${f.colors?.includes(x.value) ? 'active' : ''}" data-action="facet" data-kind="colors" data-value="${esc(x.value)}"><i style="background:${COLOR_HEX[x.value] ?? '#ccc'}"></i>${esc(cap(x.value))} <span class="n">${x.count}</span></button>`);
  const matChips = (facets?.materials ?? []).slice(0, 12).map((x) => `<button type="button" class="chip ${f.materials?.includes(x.value) ? 'active' : ''}" data-action="facet" data-kind="materials" data-value="${esc(x.value)}">${esc(cap(x.value))} <span class="n">${x.count}</span></button>`);
  const storeChips = (facets?.stores ?? []).slice(0, 10).map((x) => `<button type="button" class="chip ${f.stores?.includes(x.value.toLowerCase()) ? 'active' : ''}" data-action="facet" data-kind="stores" data-value="${esc(x.value.toLowerCase())}">${esc(x.value)} <span class="n">${x.count}</span></button>`);

  const panel = `<div class="filters" ${state.filtersOpen ? '' : 'hidden'}>
      <div class="filter-grid">
        <label class="field"><span>Category</span><select data-filter="category"><option value="">All furniture</option>${catOptions}</select></label>
        <label class="field"><span>Sort</span><select data-filter="sort">${SORTS.map(([v, l]) => `<option value="${v}" ${(f.sort ?? 'relevance') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field"><span>Min $</span><input type="number" inputmode="numeric" min="0" step="10" data-filter="minPrice" value="${f.minPrice ?? ''}" placeholder="0"></label>
        <label class="field"><span>Max $</span><input type="number" inputmode="numeric" min="0" step="10" data-filter="maxPrice" value="${f.maxPrice ?? ''}" placeholder="Any"></label>
      </div>
      <div class="chips">${PRICE_PRESETS.map(([lo, hi, l], i) => `<button type="button" class="chip ${i === pricePreset ? 'active' : ''}" data-action="price-preset" data-lo="${lo}" data-hi="${hi}">${l}</button>`).join('')}</div>
      ${facetRow('Color', colorChips)}
      ${facetRow('Material', matChips)}
      ${facetRow('Store', storeChips)}
      <label class="toggle"><input type="checkbox" data-filter="only3d" ${f.only3d ? 'checked' : ''}><span>Only items with official 3D models</span></label>
    </div>`;

  const shownIds = (b?.productIds ?? []).slice(0, state.browseShown);
  const thin = b && b.total < 6 && (f.category || f.keywords?.length);
  const liveLeft = cat?.shopping?.liveLeft ?? 0;
  const foot = !b ? `<div class="inline-empty">Ask above, or open <b>Filters</b> to browse ${cat?.total ? cat.total.toLocaleString('en-US') : 'real'} pieces.</div>`
    : `${b.productIds.length > state.browseShown ? `<button type="button" class="btn btn-secondary btn-block" data-action="browse-more">Show more</button>` : ''}
       ${b.total > b.productIds.length && b.productIds.length <= state.browseShown ? `<p class="faint center">Showing the best ${b.productIds.length} of ${b.total.toLocaleString('en-US')}. Narrow it down to see the rest.</p>` : ''}
       ${thin ? `<div class="inline-empty">${b.total ? 'Only a few matches in the catalog.' : 'Nothing in the catalog matches.'} <button type="button" class="btn btn-sm btn-soft" data-action="search-stores">${icon('search')} Search stores for more</button>${cat?.shopping?.provider !== 'none' ? `<div class="faint" style="margin-top:6px;font-size:12px">${liveLeft} live searches left this month</div>` : '<div class="faint" style="margin-top:6px;font-size:12px">IKEA only (no Google Shopping key)</div>'}</div>` : ''}
       ${b.liveSearched ? `<p class="faint center">Also searched stores for “${esc(b.liveSearched)}”.</p>` : ''}`;

  if (!el.querySelector(':scope > .browse-top')) {
    el.innerHTML = `<div class="browse-top"></div><div class="browse-chips"></div><div class="browse-panel"></div><div class="browse-grid" role="list"></div><div class="browse-foot"></div>`;
  }
  setHTML(el.querySelector('.browse-top'), `<div class="browse-head">${head}</div>
    <button type="button" class="btn btn-sm ${state.filtersOpen ? 'btn-soft' : 'btn-secondary'}" data-action="toggle-filters" aria-expanded="${state.filtersOpen}">${icon('sliders')} Filters${chips.length ? ` <span class="count">${chips.length}</span>` : ''}</button>`);
  setHTML(el.querySelector('.browse-chips'), chips.length ? `<div class="chips">${chips.map(([k, v, l]) => `<button type="button" class="chip active" data-action="unfilter" data-kind="${k}" data-value="${esc(v ?? '')}">${esc(l)} ${icon('x')}</button>`).join('')}<button type="button" class="chip" data-action="clear-filters">Clear all</button></div>` : '');
  // Don't rebuild the panel while the user is typing a price (would steal focus); dropdowns/chips are fine.
  const panelEl = el.querySelector('.browse-panel');
  const typing = document.activeElement?.tagName === 'INPUT' && document.activeElement.type === 'number' && panelEl.contains(document.activeElement);
  if (!typing) setHTML(panelEl, panel);
  const grid = el.querySelector('.browse-grid');
  const cart = new Set((s?.cart ?? []).map((c) => c.productId));
  patchList(grid, shownIds.filter((id) => s.products?.[id]), (id) => id, (card, id) => updateCard(card, s.products[id], cart.has(id)), createCard);
  setHTML(el.querySelector('.browse-foot'), foot);
}

let filterTimer = 0;
function currentFilters() {
  return { ...(state.session?.browse?.filters ?? {}) };
}

async function applyFilters(f, { debounce = 0 } = {}) {
  const s = state.session;
  if (!s) return;
  clearTimeout(filterTimer);
  // Optimistic: show the chips right away, results follow.
  s.browse = { ...(s.browse ?? { productIds: [], total: 0, priceRange: null, facets: null }), filters: f };
  state.browseShown = BROWSE_PAGE;
  renderSession();
  filterTimer = setTimeout(async () => {
    try {
      state.inflight++;
      const d = await api(`/api/sessions/${encodeURIComponent(s.id)}/browse`, { method: 'PUT', body: { filters: f } });
      state.inflight--;
      if (state.inflight === 0) applySession(d);
    } catch (e) {
      state.inflight--;
      toast(e.message || 'Couldn’t filter.', { type: 'error' });
    }
  }, debounce);
}

function toggleFacet(kind, value) {
  const f = currentFilters();
  const cur = new Set(f[kind] ?? []);
  if (cur.has(value)) cur.delete(value); else cur.add(value);
  f[kind] = [...cur];
  if (!f[kind].length) delete f[kind];
  applyFilters(f);
}

function removeFilter(kind, value) {
  const f = currentFilters();
  if (kind === 'price') { delete f.minPrice; delete f.maxPrice; }
  else if (kind === 'size') { delete f.maxWidthM; delete f.maxDepthM; delete f.maxHeightM; }
  else if (Array.isArray(f[kind])) { f[kind] = f[kind].filter((x) => x !== value); if (!f[kind].length) delete f[kind]; }
  else delete f[kind];
  applyFilters(f);
}

document.addEventListener('change', (e) => {
  const t = e.target.closest('[data-filter]');
  if (!t) return;
  const f = currentFilters();
  const k = t.dataset.filter;
  if (k === 'only3d') { if (t.checked) f.only3d = true; else delete f.only3d; }
  else if (k === 'minPrice' || k === 'maxPrice') { const v = Number(t.value); if (v > 0) f[k] = v; else delete f[k]; }
  else if (t.value) f[k] = t.value;
  else delete f[k];
  applyFilters(f, { debounce: k.endsWith('Price') ? 300 : 0 });
});

async function searchStores() {
  const s = state.session;
  if (!s || state.asking) return;
  state.asking = 'Search stores for more';
  renderSession();
  try {
    const d = await api(`/api/sessions/${encodeURIComponent(s.id)}/browse/more`, { method: 'POST', body: {} });
    state.asking = null;
    applySession(d.session);
    loadCatalog();
    toast(d.added > 0 ? `Found ${d.added} more from stores.` : d.liveSearched ? 'Checked stores; nothing new matched.' : 'Already searched stores for this (or the monthly limit is reached).', { type: d.added > 0 ? 'success' : 'info' });
  } catch (e) {
    state.asking = null;
    renderSession();
    toast(e.message || 'Store search failed.', { type: 'error' });
  }
}

function handleAssistant(d) {
  if (d?.session) applySession(d.session);
  state.browseShown = BROWSE_PAGE;
  const pid = d?.productId;
  if (pid) state.focusId = pid;
  if ((d?.action === 'open' || d?.action === 'place') && pid) open3D(pid);
  else if (d?.browse) requestAnimationFrame(() => $('#s-browse')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  if (d?.action === 'place') toast('Put on your Quest to place it in your room.', { type: 'info' });
}

async function submitAsk(text) {
  if (!text || state.asking) return;
  const s = state.session;
  const id = s?.id ?? state.route.id;
  if (!id || id === 'latest') return;
  state.asking = text;
  const input = $('#ask-input');
  if (input) { input.value = ''; input.blur(); }
  renderSession();
  try {
    const d = await api(`/api/sessions/${encodeURIComponent(id)}/ask`, { method: 'POST', body: { text, focusProductId: state.focusId || undefined } });
    state.asking = null;
    handleAssistant(d);
  } catch (e) {
    state.asking = null;
    renderSession();
    toast(e.message || 'The assistant didn’t answer.', { type: 'error' });
  }
}

async function toggleMic() {
  if (state.rec) { state.rec.recorder.stop(); return; }
  const s = state.session;
  if (!s || state.asking) return;
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { toast('Microphone blocked. Allow it in Settings, or use the keyboard’s dictation key.', { type: 'error' }); return; }
  const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported?.(t)) ?? '';
  const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    state.rec = null;
    const blob = new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' });
    if (blob.size < 2000) { renderSession(); toast('Tap the mic, speak, then tap again.', { type: 'info' }); return; }
    state.asking = '🎙️ …';
    renderSession();
    const form = new FormData();
    form.append('audio', blob, /mp4/.test(blob.type) ? 'speech.m4a' : 'speech.webm');
    if (state.focusId) form.append('focusProductId', state.focusId);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(s.id)}/voice`, { method: 'POST', body: form });
      const d = await res.json().catch(() => null);
      state.asking = null;
      if (!res.ok) throw new Error(d?.error || `Voice failed (${res.status})`);
      if (!d?.transcript) { renderSession(); toast(d?.reply || 'Didn’t catch that.', { type: 'info' }); return; }
      handleAssistant(d);
    } catch (e) {
      state.asking = null;
      renderSession();
      toast(e.message || 'Voice failed.', { type: 'error' });
    }
  };
  state.rec = { recorder, chunks, stream };
  recorder.start();
  renderSession();
  setTimeout(() => { if (state.rec?.recorder === recorder) recorder.stop(); }, 15000);
}

// ============================================================================ CART
async function setQty(pid, qty) {
  const s = state.session;
  if (!s || !pid) return;
  qty = Math.max(0, Math.min(20, Math.round(qty)));
  const prevCart = s.cart ?? [];
  const old = prevCart.find((c) => c.productId === pid);
  if (!state.cartOrder.has(pid)) state.cartOrder.set(pid, state.cartOrder.size);
  const next = prevCart.filter((c) => c.productId !== pid);
  if (qty > 0) next.push({ productId: pid, qty, addedAt: old?.addedAt ?? Date.now() });
  s.cart = next;
  state.inflight++;
  renderAll();
  try {
    const d = await api(`/api/sessions/${encodeURIComponent(s.id)}/cart`, { method: 'POST', body: { productId: pid, qty } });
    state.inflight--;
    if (state.inflight === 0 && d?.id === s.id) applySession(d);
    return true;
  } catch (e) {
    state.inflight--;
    s.cart = prevCart;
    renderAll();
    toast(e.message || 'Couldn’t update the cart.', { type: 'error' });
    return false;
  }
}

async function toggleCart(pid) {
  const inCart = cartQty(pid) > 0;
  const ok = await setQty(pid, inCart ? 0 : 1);
  if (ok && !inCart && state.route.name === 'session') {
    toast(`Added ${shortTitle(product(pid)?.title) || 'item'} to your cart.`, { type: 'success', action: { label: 'View cart', href: `#/s/${encodeURIComponent(state.session.id)}/cart` } });
  }
}

function viewCart() {
  app.innerHTML = `
    <div class="page-head"><h1>Your cart</h1><p class="muted" id="c-sub">&nbsp;</p></div>
    <div id="c-budget"></div>
    <div id="c-groups" class="stack"></div>
    <p class="note">${icon('info')}<span>Checkout happens on each retailer’s website. Prices from live listings.</span></p>
  `;
  renderCart();
}

function renderCart() {
  if (state.route.name !== 'cart' || !$('#c-groups')) return;
  if (state.notFound) return renderNotFound();
  const s = state.session?.id === state.route.id ? state.session : null;
  if (!s) {
    setHTML($('#c-budget'), `<section class="card budget-card"><div class="skel" style="height:14px;width:30%"></div><div class="skel skel-title" style="margin-top:10px"></div><div class="skel" style="height:8px;margin-top:16px"></div></section>`);
    setHTML($('#c-groups'), `<section class="card"><div class="skel skel-line" style="width:40%;margin:0"></div><div class="skel skel-line" style="width:90%;height:64px;margin-top:16px"></div></section>`);
    return;
  }
  const items = (s.cart ?? [])
    .map((c) => ({ ...c, p: s.products?.[c.productId] }))
    .filter((x) => x.p)
    .sort((a, b) => (state.cartOrder.get(a.productId) ?? 1e9) - (state.cartOrder.get(b.productId) ?? 1e9));
  const count = items.reduce((n, x) => n + x.qty, 0);
  if (!items.length) {
    $('#c-sub').textContent = 'Nothing here yet';
    setHTML($('#c-budget'), '');
    setHTML($('#c-groups'), `<section class="card empty"><div class="empty-icon">${icon('bag')}</div><h2>Your cart is empty</h2><p>Tap “Add to cart” on anything you like, or add items while you’re walking around in VR.</p><a class="btn btn-primary" href="#/s/${encodeURIComponent(s.id)}">${icon('sofa')} Browse your picks</a></section>`);
    return;
  }
  const currency = items.find((x) => x.p.currency)?.p.currency || 'USD';
  const total = items.reduce((sum, x) => sum + (Number(x.p.price) || 0) * x.qty, 0);
  const unpriced = items.filter((x) => x.p.price == null).length;
  const groups = new Map();
  for (const x of items) {
    const k = x.p.store || (x.p.source === 'ikea' ? 'IKEA' : 'Online store');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  $('#c-sub').textContent = `${count} item${count === 1 ? '' : 's'} from ${groups.size} store${groups.size === 1 ? '' : 's'}`;

  const budget = Number(s.budget) || 0;
  const pct = budget ? (total / budget) * 100 : 0;
  const over = budget && total > budget;
  setHTML($('#c-budget'), `<section class="card budget-card">
    <div class="budget-top">
      <div><span class="label">Total</span><strong class="total">${money(total, currency)}</strong></div>
      ${budget ? `<div class="right"><span class="label">Budget</span><strong>${money(budget, currency)}</strong></div>` : ''}
    </div>
    ${budget ? `<div class="bar ${over ? 'over' : ''}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(Math.min(pct, 100))}" aria-label="Budget used"><i style="width:${Math.min(100, pct).toFixed(1)}%"></i></div>
    <p class="budget-msg ${over ? 'over' : 'ok'}">${over ? `${money(total - budget, currency)} over budget` : `${money(budget - total, currency)} left · ${Math.round(pct)}% of budget`}</p>` : '<p class="budget-msg muted" style="color:var(--text-2)">No budget set for this room.</p>'}
    ${unpriced ? `<p class="muted" style="font-size:13px;margin-top:6px">${unpriced} item${unpriced === 1 ? ' has' : 's have'} no listed price and isn’t counted.</p>` : ''}
  </section>`);

  setHTML($('#c-groups'), [...groups.entries()].map(([storeName, list]) => storeGroupHtml(storeName, list, currency)).join(''));
}

function storeGroupHtml(storeName, list, currency) {
  const subtotal = list.reduce((sum, x) => sum + (Number(x.p.price) || 0) * x.qty, 0);
  const n = list.reduce((a, x) => a + x.qty, 0);
  const rows = list.map(({ p, qty }) => {
    const unit = p.price != null ? money(p.price, p.currency || currency) : priceLabel(p);
    const line = p.price != null ? money(p.price * qty, p.currency || currency) : '';
    return `<li>
      <a class="ci-img" href="${esc(safeUrl(p.productUrl))}" target="_blank" rel="noopener noreferrer" tabindex="-1" aria-hidden="true">${imageOf(p) ? `<img src="${esc(proxy(imageOf(p), 192))}" alt="" loading="lazy" data-fallback>` : `<div class="ph">${icon('image')}</div>`}</a>
      <div class="ci-main">
        <div class="ci-top"><a class="ci-title" href="${esc(safeUrl(p.productUrl))}" target="_blank" rel="noopener noreferrer">${esc(p.title)}</a><span class="ci-line">${esc(line)}</span></div>
        <div class="ci-price">${esc(unit)}${qty > 1 && p.price != null ? ' each' : ''}</div>
        <div class="ci-controls">
          <div class="stepper" role="group" aria-label="Quantity">
            <button type="button" data-action="qty" data-id="${esc(p.id)}" data-qty="${qty - 1}" aria-label="Decrease quantity" ${qty <= 1 ? 'disabled' : ''}>${icon('minus')}</button>
            <output aria-live="polite">${qty}</output>
            <button type="button" data-action="qty" data-id="${esc(p.id)}" data-qty="${qty + 1}" aria-label="Increase quantity" ${qty >= 20 ? 'disabled' : ''}>${icon('plus')}</button>
          </div>
          <button type="button" class="icon-btn danger" data-action="qty" data-id="${esc(p.id)}" data-qty="0" aria-label="Remove ${esc(shortTitle(p.title))}">${icon('trash')}</button>
          <button type="button" class="btn btn-sm btn-ghost ci-link" data-action="view-3d" data-id="${esc(p.id)}">${icon('cube')} 3D</button>
        </div>
      </div>
    </li>`;
  }).join('');
  const buyLabel = `Buy at ${esc(storeName)} ${icon('external')}`;
  const buy = list.length === 1
    ? `<a class="btn btn-primary btn-block" href="${esc(safeUrl(list[0].p.productUrl))}" target="_blank" rel="noopener noreferrer">${buyLabel}</a>`
    : `<details class="buy-list" data-store="${esc(storeName)}" ${state.openStores.has(storeName) ? 'open' : ''}>
        <summary class="btn btn-primary btn-block">${buyLabel}${icon('chevronDown', 'chev')}</summary>
        <ol>${list.map(({ p, qty }) => `<li><a href="${esc(safeUrl(p.productUrl))}" target="_blank" rel="noopener noreferrer"><span>${esc(p.title)}${qty > 1 ? ` × ${qty}` : ''}</span>${icon('external')}</a></li>`).join('')}</ol>
        <p class="muted">Open each item on ${esc(storeName)}’s site and add it to your cart there.</p>
      </details>`;
  return `<section class="card store-group">
    <header class="store-head"><div class="store-logo">${esc(storeName.trim().charAt(0).toUpperCase() || '?')}</div><div><h2>${esc(storeName)}</h2><p class="muted">${n} item${n === 1 ? '' : 's'}</p></div><span class="subtotal">${money(subtotal, currency)}</span></header>
    <ul class="cart-items">${rows}</ul>
    <footer class="store-foot"><div class="sub"><span>Subtotal</span><strong>${money(subtotal, currency)}</strong></div>${buy}</footer>
  </section>`;
}

document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (d instanceof HTMLDetailsElement && d.dataset.store) {
    if (d.open) state.openStores.add(d.dataset.store);
    else state.openStores.delete(d.dataset.store);
  }
}, true);

// ============================================================================ MODAL (3D viewer, photo lightbox)
let modalSeq = 0;
let lastFocus = null;

function openModal(html, info) {
  const modal = $('#modal');
  const sheet = modal.querySelector('.modal-sheet');
  modalSeq++;
  lastFocus = document.activeElement;
  sheet.innerHTML = html;
  sheet.scrollTop = 0;
  modal.hidden = false;
  document.documentElement.classList.add('modal-open');
  state.modal = { ...info, token: modalSeq };
  requestAnimationFrame(() => requestAnimationFrame(() => modal.classList.add('open')));
  setTimeout(() => sheet.querySelector('[data-action=close-modal]')?.focus({ preventScroll: true }), 50);
  return modalSeq;
}

function closeModal(immediate = false) {
  const modal = $('#modal');
  if (modal.hidden) return;
  const seq = ++modalSeq;
  state.modal = null;
  modal.classList.remove('open');
  document.documentElement.classList.remove('modal-open');
  const done = () => {
    if (seq !== modalSeq) return;
    modal.hidden = true;
    modal.querySelector('.modal-sheet').innerHTML = ''; // frees the WebGL context
  };
  if (immediate) done();
  else setTimeout(done, 280);
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus?.({ preventScroll: true });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.modal) closeModal();
});

function openPhoto(src) {
  openModal(`<div class="grabber"></div>
    <div class="sheet-head"><div><h2 id="modal-title">Room photo</h2></div><button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">${icon('x')}</button></div>
    <div class="lightbox"><img src="${esc(proxy(src, 1024))}" alt="Room photo"></div>`, { kind: 'photo' });
}

let mvPromise = null;
function ensureModelViewer() {
  if (customElements.get('model-viewer')) return Promise.resolve();
  if (!mvPromise) {
    mvPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.type = 'module';
      s.src = MV_URL;
      s.onerror = () => { mvPromise = null; s.remove(); reject(new Error('Couldn’t load the 3D viewer. Are you online?')); };
      document.head.appendChild(s);
      customElements.whenDefined('model-viewer').then(resolve);
    });
  }
  return mvPromise;
}
function preloadModelViewer() {
  const go = () => ensureModelViewer().catch(() => {});
  if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 3000 });
  else setTimeout(go, 1500);
}

function sheetHeadHtml(p) {
  const d = dimsParts(p.dims);
  return `<div class="grabber"></div>
    <div class="sheet-head">
      <div><div class="card-store">${esc(p.store || 'Store')}</div><h2 id="modal-title">${esc(p.title)}</h2>
      <p class="muted">${esc(priceLabel(p))}${d ? ` · ${d.cm.join(' × ')} cm` : ''}</p></div>
      <button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">${icon('x')}</button>
    </div>`;
}

function waitHtml(p, { title, sub, pct, error, retry } = {}) {
  const img = imageOf(p);
  return `<div class="viewer-wait">
    ${img ? `<img class="viewer-bg" src="${esc(proxy(img, 480))}" alt="">` : ''}
    <div class="wait-card ${error ? 'err' : ''}">
      ${error ? icon('alert', 'i-big') : '<div class="spinner"></div>'}
      <strong>${esc(title)}</strong>
      ${sub ? `<span class="muted">${esc(sub)}</span>` : ''}
      ${pct != null && !error ? `<div class="bar"><i style="width:${Math.max(4, Math.round(pct * 100))}%"></i></div><span class="muted">${Math.round(pct * 100)}%</span>` : ''}
      ${retry ? `<button type="button" class="btn btn-sm btn-primary" data-action="retry-model" data-id="${esc(p.id)}">${icon('refresh')} Try again</button>` : ''}
    </div>
  </div>`;
}

function modalFootHtml(p) {
  const inCart = cartQty(p.id) > 0;
  const d = dimsParts(p.dims);
  const m = p.model ?? {};
  const kind = m.status === 'ready' ? KIND_TEXT[m.kind] ?? '' : '';
  return `
    ${kind ? `<div class="kind-line">${badge3d(p)}<span>${esc(kind)}</span></div>` : ''}
    ${d ? `<div class="dims-big">${['Width', 'Depth', 'Height'].map((lbl, i) => `<div><small>${lbl}</small><b>${d.cm[i]} cm</b><span>${d.inch[i]} in</span></div>`).join('')}</div>` : ''}
    <div class="btn-row">
      <button type="button" class="btn btn-soft btn-cart ${inCart ? 'in' : ''}" data-action="toggle-cart" data-id="${esc(p.id)}" aria-pressed="${inCart}">${icon('heart', inCart ? 'i-fill' : '')}${inCart ? 'In cart' : 'Add to cart'}</button>
      <a class="btn btn-secondary" href="${esc(safeUrl(p.productUrl))}" target="_blank" rel="noopener noreferrer">Store ${icon('external')}</a>
    </div>`;
}

function renderModalFoot() {
  const m = state.modal;
  if (!m || m.kind !== '3d') return;
  const p = product(m.pid) ?? m.product;
  if (p) setHTML($('#modal .sheet-foot'), modalFootHtml(p));
}

function upsertProduct(p) {
  if (!p?.id) return;
  if (state.session?.products) state.session.products[p.id] = p;
  if (state.modal?.pid === p.id) state.modal.product = p;
}

async function open3D(pid) {
  let p = product(pid);
  if (!p) {
    try { p = await api(`/api/products/${encodeURIComponent(pid)}`); } catch (e) { return toast(e.message, { type: 'error' }); }
  }
  const token = openModal(`${sheetHeadHtml(p)}<div class="viewer" id="viewer"></div><div class="sheet-foot"></div>`, { kind: '3d', pid, product: p });
  renderModalFoot();
  ensureModelViewer().catch(() => {});
  prepareAndShow(p, token);
}

async function prepareAndShow(p, token) {
  const alive = () => state.modal?.token === token;
  const viewer = () => $('#viewer');
  const started = Date.now();
  try {
    if (!(p.model?.status === 'ready' && p.model?.url)) {
      setHTML(viewer(), waitHtml(p, { title: 'Preparing 3D model…', sub: 'Starting', pct: 0.02 }));
      p = await api(`/api/products/${encodeURIComponent(p.id)}/model`, { method: 'POST', body: { generate: true } });
      upsertProduct(p);
      let reposted = false;
      while (alive() && !(p.model?.status === 'ready' && p.model?.url) && p.model?.status !== 'failed') {
        if (p.model?.status === 'none') {
          if (reposted) throw new Error('The model job didn’t start.');
          reposted = true;
          p = await api(`/api/products/${encodeURIComponent(p.id)}/model`, { method: 'POST', body: { generate: true } });
          upsertProduct(p);
          continue;
        }
        if (Date.now() - started > 6 * 60 * 1000) throw new Error('This is taking longer than expected.');
        const m = p.model ?? {};
        setHTML(viewer(), waitHtml(p, { title: m.status === 'queued' ? 'Waiting in line…' : 'Building 3D model…', sub: m.message || 'Working', pct: Number(m.progress) || 0.03 }));
        await sleep(1000);
        if (!alive()) return;
        p = await api(`/api/products/${encodeURIComponent(p.id)}`);
        upsertProduct(p);
        renderAll();
      }
      if (!alive()) return;
      renderAll();
      if (p.model?.status === 'failed') {
        setHTML(viewer(), waitHtml(p, { title: 'Couldn’t build a 3D model', sub: p.model.message || 'The model service failed for this item.', error: true, retry: true }));
        return;
      }
    }
    if (!alive()) return;
    setHTML(viewer(), waitHtml(p, { title: 'Loading 3D viewer…' }));
    await ensureModelViewer();
    if (!alive()) return;
    mountViewer(p);
  } catch (e) {
    if (!alive()) return;
    setHTML(viewer(), waitHtml(p, { title: 'Couldn’t show this in 3D', sub: e.message, error: true, retry: true }));
  }
}

function mountViewer(p) {
  const v = $('#viewer');
  const src = safeModelUrl(p.model.url);
  if (!v || !src) return;
  const poster = imageOf(p) ? proxy(imageOf(p), 480) : '';
  v._html = null;
  v.innerHTML = `<model-viewer src="${esc(src)}" ${poster ? `poster="${esc(poster)}"` : ''} alt="3D model of ${esc(p.title)}"
      camera-controls auto-rotate auto-rotate-delay="800" shadow-intensity="1" shadow-softness="0.8" environment-image="neutral" exposure="1.05"
      ar ar-modes="webxr scene-viewer quick-look" ar-scale="fixed" touch-action="none" interaction-prompt="none">
      <button slot="ar-button" class="ar-btn">${icon('cube')} View in your room</button>
    </model-viewer>
    <div class="viewer-hint">Drag to rotate · pinch to zoom</div>`;
  const mv = v.querySelector('model-viewer');
  mv.addEventListener('error', () => {
    setHTML(v, waitHtml(p, { title: 'The 3D file didn’t load', sub: 'Try rebuilding it.', error: true, retry: true }));
  }, { once: true });
  mv.addEventListener('load', () => { const h = v.querySelector('.viewer-hint'); if (h) setTimeout(() => h.remove(), 3500); }, { once: true });
  // Dimensions are often only known once the model is built: refresh the header line.
  const d = dimsParts(p.dims);
  const sub = $('#modal .sheet-head p');
  if (sub) sub.textContent = `${priceLabel(p)}${d ? ` · ${d.cm.join(' × ')} cm` : ''}`;
  renderModalFoot();
}

// ============================================================================ misc actions
async function copyCode(code) {
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(code); ok = true; }
  } catch { /* fall through */ }
  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = code;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, code.length);
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  toast(ok ? `Session code ${code} copied.` : `Session code: ${code}`, { type: ok ? 'success' : 'info' });
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const id = t.dataset.id;
  switch (t.dataset.action) {
    case 'pick-camera': $('#in-camera')?.click(); break;
    case 'pick-library': $('#in-library')?.click(); break;
    case 'remove-photo': removePhoto(id); break;
    case 'prompt-chip': {
      const el = $('#prompt');
      el.value = t.dataset.value;
      saveDraft(); syncChips(); updateCta();
      break;
    }
    case 'budget-chip': {
      $('#budget').value = t.dataset.value;
      saveDraft(); syncChips();
      break;
    }
    case 'design': design(); break;
    case 'demo': demo(); break;
    case 'retry-recent': loadRecent(); break;
    case 'toggle-cart': toggleCart(id); break;
    case 'view-3d': if (id) { state.focusId = id; open3D(id); } break;
    case 'retry-model': {
      const p = product(id) ?? state.modal?.product;
      if (p && state.modal) prepareAndShow({ ...p, model: { status: 'none' } }, state.modal.token);
      break;
    }
    case 'qty': setQty(id, Number(t.dataset.qty)); break;
    case 'scroll-row': {
      const row = t.closest('.cat')?.querySelector('.row');
      row?.scrollBy({ left: Number(t.dataset.dir) * row.clientWidth * 0.85, behavior: 'smooth' });
      break;
    }
    case 'ask-example': submitAsk(t.dataset.value); break;
    case 'mic': toggleMic(); break;
    case 'toggle-filters': state.filtersOpen = !state.filtersOpen; renderSession(); break;
    case 'facet': toggleFacet(t.dataset.kind, t.dataset.value); break;
    case 'unfilter': removeFilter(t.dataset.kind, t.dataset.value); break;
    case 'clear-filters': applyFilters({}); break;
    case 'price-preset': {
      const f = currentFilters();
      const lo = Number(t.dataset.lo), hi = Number(t.dataset.hi);
      if (lo) f.minPrice = lo; else delete f.minPrice;
      if (hi) f.maxPrice = hi; else delete f.maxPrice;
      applyFilters(f);
      break;
    }
    case 'browse-more': state.browseShown += BROWSE_PAGE; renderSession(); break;
    case 'search-stores': searchStores(); break;
    case 'copy-code': copyCode(t.dataset.code); break;
    case 'open-photo': openPhoto(t.dataset.src); break;
    case 'close-modal': closeModal(); break;
  }
});

// Broken product image → neutral placeholder instead of a broken icon.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img instanceof HTMLImageElement && img.hasAttribute('data-fallback')) {
    const ph = document.createElement('div');
    ph.className = 'ph';
    ph.innerHTML = icon('image');
    img.replaceWith(ph);
  }
}, true);

// Hairline under the top bar once content scrolls beneath it.
const topbar = $('.topbar');
let scrolled = false;
window.addEventListener('scroll', () => {
  const s = window.scrollY > 4;
  if (s !== scrolled) { scrolled = s; topbar.classList.toggle('scrolled', s); }
}, { passive: true });

// ============================================================================ boot
window.addEventListener('hashchange', onRoute);
loadHealth();
onRoute();
