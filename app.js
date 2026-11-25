/* ============================================================
   Hope Ave Fuel — app logic
   ------------------------------------------------------------
   Organized into sections. Several behaviors here are deliberate and
   fragile — see DECISIONS.md before changing:
     • hover bridge (HOVER_OPEN_MS 40 / HOVER_CLOSE_MS 80) + pointer-events rules
     • crossfade (renderMarkers -> drawMarkers)
     • off-screen / behind-toolbar edge chips (transform-positioned, de-overlapped)
     • mobile tap re-centering (centerPopupOnMobile: panTo vs flyTo)
     • tile-host fallback chain -> vector fallback
   Live data comes only through window.FuelServices (services.js); only the
   NOW / HOME constants are read from window.FuelData (data.js).
   ============================================================ */
(function () {
'use strict';

/* ===================== config / state ===================== */
const { NOW, HOME } = window.FuelData;

// DATA is the *active* set of stations on screen, which home / search / "near me"
// swap out. `origin` is the current reference point — home, a searched place, or the
// device location. DATA starts empty and is populated asynchronously at boot() from
// the services layer (the Google proxy).
let DATA = [];
let origin = { lat: HOME.lat, lng: HOME.lng, label: 'Hope Ave', fullLabel: '60 Hope Ave, Waltham, MA', isHome: true };

// Search radius around the origin, set by the toolbar slider. Deliberately NOT
// persisted: every page load starts back at the 2.5 mi default.
const MI_TO_M = 1609.34;
const RADIUS_DEFAULT_MI = 2.5;
let radiusM = Math.round(RADIUS_DEFAULT_MI * MI_TO_M);

// Padding (px) reserved for the floating toolbar card when framing the map.
// `top` is a fixed compromise for DESKTOP (card only covers the top-left);
// on mobile the toolbar spans the full width and its real height varies, so
// framing measures it live via framePadTop() instead.
const PAD = { top: 150, bottom: 40, side: 36 };
function framePadTop() {
  if (window.matchMedia('(max-width:640px)').matches) {
    const st = document.querySelector('.topstack');
    if (st) return Math.round(st.getBoundingClientRect().bottom) + 10;
  }
  return PAD.top;
}
// Space the open chat panel covers, so framing / popup centering / edge chips
// keep results out from under it. Desktop: a column at the bottom-right → right
// inset. Mobile: a full-width sheet at the bottom → bottom inset. 0 when closed.
function chatRect() {
  const p = document.getElementById('chatPanel');
  return p && !p.hidden ? p.getBoundingClientRect() : null;
}
const IS_MOBILE_W = () => window.matchMedia('(max-width:640px)').matches;
function chatRightInset() { const r = chatRect(); return r && !IS_MOBILE_W() ? Math.round(window.innerWidth - r.left) : 0; }
function chatBottomInset() { const r = chatRect(); return r && IS_MOBILE_W() ? Math.round(window.innerHeight - r.top) : 0; }

const GLAB = { REGULAR_UNLEADED: 'Reg', MIDGRADE: 'Mid', PREMIUM: 'Prem', DIESEL: 'Dies' };
const GFULL = { REGULAR_UNLEADED: 'Regular', MIDGRADE: 'Midgrade', PREMIUM: 'Premium', DIESEL: 'Diesel' };
const GORD = ['REGULAR_UNLEADED', 'MIDGRADE', 'PREMIUM'];   // active grades (Diesel intentionally excluded)
let state = { grade: 'PREMIUM', brands: new Set() };        // default grade is Premium; brands set built per result set

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// straight-line miles between two lat/lng points (haversine)
function distMi(aLat, aLng, bLat, bLng) {
  const R = 3958.8, toRad = d => d * Math.PI / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ===================== price / freshness logic ===================== */
const priceOf = (s, g) => { const f = s.fuelPrices.find(p => p.type === g); return f ? f.price : null; };
const updOf   = (s, g) => { const f = s.fuelPrices.find(p => p.type === g); return f ? f.updateTime : null; };

function ageInfo(iso) {
  if (!iso) return { cls: 'fb-nodata', label: 'no data' };
  const h = (NOW - new Date(iso).getTime()) / 3600000;
  const txt = h < 1 ? Math.round(h * 60) + 'm ago' : h < 24 ? Math.round(h) + 'h ago' : Math.round(h / 24) + 'd ago';
  if (h < 12) return { cls: 'fb-fresh', label: txt };
  if (h < 48) return { cls: 'fb-aging', label: txt };
  return { cls: 'fb-stale', label: txt };
}

const visible = () => DATA.filter(s => state.brands.has(s.brand));
const byGrade = sort => {
  const p = visible().filter(s => priceOf(s, state.grade) != null);
  return p.length ? [...p].sort(sort)[0] : null;
};
const cheapest = () => byGrade((a, b) => priceOf(a, state.grade) - priceOf(b, state.grade));
const dearest  = () => byGrade((a, b) => priceOf(b, state.grade) - priceOf(a, state.grade));

/* ===================== brand registry =====================
   The curated set of "major" brands. Each entry has a display label, an accent
   color (drives the pin/chip/dot theming via the inline --brand CSS var), the
   OSM tag aliases that map to it, and optionally a real logo (Simple Icons).
   Anything a search result doesn't match falls into 'other' (independents /
   unbranded), which the toolbar shows as a togglable bucket, off by default.
   To add/remove a brand, just edit this object — the filter UI is built from it. */
const BRANDS = {
  shell:      { label: 'Shell',          color: '#e0b000', logo: 'https://cdn.simpleicons.org/shell', aliases: ['shell'] },
  mobil:      { label: 'Exxon/Mobil',    color: '#e30000', svg: '<svg class="{cls}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect width="24" height="24" rx="4" fill="#1a1a8c"/><text x="12" y="11" font-size="7" font-weight="900" fill="white" text-anchor="middle" font-family="Arial,sans-serif">Mobil</text><circle cx="12" cy="17" r="3.5" fill="#e30000"/></svg>', aliases: ['mobil', 'exxon', 'esso'] },
  bp:         { label: 'BP/Amoco',       color: '#007a4d', svg: '<svg class="{cls}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="11" fill="#007a4d"/><text x="12" y="16.5" font-size="9" font-weight="900" fill="#ffda00" text-anchor="middle" font-family="Arial,sans-serif">bp</text></svg>', aliases: ['bp', 'amoco', 'arco'] },
  chevron:    { label: 'Chevron/Texaco', color: '#0054a5', svg: '<svg class="{cls}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M1,3 L12,10 L23,3 L23,9 L12,15 L1,9 Z" fill="#0054a5"/><path d="M1,11 L12,18 L23,11 L23,17 L12,23 L1,17 Z" fill="#e31837"/></svg>', aliases: ['chevron', 'texaco', 'caltex'] },
  phillips66: { label: 'Phillips 66',    color: '#c41230', svg: '<svg class="{cls}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2.5L20 6v8c0 4.5-8 8-8 8s-8-3.5-8-8V6z" fill="#c41230"/><text x="12" y="16" font-size="7.5" font-weight="900" fill="white" text-anchor="middle" font-family="Arial,sans-serif">66</text></svg>', aliases: ['phillips 66', 'phillips66', 'p66'] },
};
const BRAND_ORDER = Object.keys(BRANDS);
const OTHER = { label: 'Other', color: '#9aa0a8' };   // independents / unbranded bucket

// Precompile a word-boundary matcher per brand so e.g. "bp" doesn't match inside another word.
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
BRAND_ORDER.forEach(k => { BRANDS[k]._re = new RegExp(`\\b(${BRANDS[k].aliases.map(escapeRe).join('|')})\\b`, 'i'); });
function classifyBrand(tags) {
  const hay = `${tags.brand || ''} ${tags.operator || ''} ${tags.name || ''}`;
  for (const k of BRAND_ORDER) if (BRANDS[k]._re.test(hay)) return k;
  return 'other';
}
const brandColor = key => (BRANDS[key] && BRANDS[key].color) || '';
const brandLabel = key => key === 'other' ? OTHER.label : (BRANDS[key] ? BRANDS[key].label : key);

/* ----- brand logos: real logo (Simple Icons) where we have one, generic pump SVG otherwise ----- */
const PUMP = '<line x1="3" x2="15" y1="22" y2="22"/><line x1="4" x2="14" y1="9" y2="9"/><path d="M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18"/><path d="M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 2 2 2 2 0 0 0 2-2V9.83a2 2 0 0 0-.59-1.42L18 5"/>';
function pumpSvg(color, cls) { return `<svg class="${cls || 'bi'}" style="color:${color}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${PUMP}</svg>`; }
function makePumpEl(brand, cls) { const color = brandColor(brand) || 'var(--muted-2)'; const t = document.createElement('template'); t.innerHTML = pumpSvg(color, cls).trim(); return t.content.firstChild; }
function brandImg(brand, cls) { const m = BRANDS[brand]; if (!m) return pumpSvg(brandColor(brand) || 'var(--muted-2)', cls); if (m.svg) return m.svg.replace(/\{cls\}/g, cls || 'bi'); if (m.logo) return `<img class="${cls || 'bi'}" data-brand="${brand}" src="${m.logo}" alt="${m.label} logo">`; return pumpSvg(brandColor(brand) || 'var(--muted-2)', cls); }

/* Attach fallbacks in JS (no inline onerror -> no load-order race). Also swap any image that already errored before we got here. */
function applyLogoFallbacks(scope) {
  (scope || document).querySelectorAll('img[data-brand]:not([data-wired])').forEach(img => {
    img.setAttribute('data-wired', '1');
    const swap = () => img.replaceWith(makePumpEl(img.getAttribute('data-brand'), img.getAttribute('class') || 'bi'));
    if (img.complete && img.naturalWidth === 0) { swap(); return; }   // already failed
    img.addEventListener('error', swap, { once: true });              // fails later
  });
}

/* ===================== toolbar brand filter (multi-select checkboxes) =====================
   The registry is the fixed source of truth, so EVERY registry brand (plus the
   'Other' bucket) is ALWAYS shown as an option, in registry order, in every
   location — its count is just 0 when nothing in radius matches. A leading "All"
   master toggle precedes them. Major brands start checked; 'Other' starts
   unchecked so independents are hidden by default. Rebuilt on every result swap
   (reset=true); individual toggles just update state + redraw. */
const FILTER_KEYS = [...BRAND_ORDER, 'other'];   // fixed, location-independent set of filter options
function brandCounts() {
  const c = {};
  FILTER_KEYS.forEach(k => { c[k] = 0; });        // seed every group at 0 so empty ones still report
  DATA.forEach(s => { c[s.brand] = (c[s.brand] || 0) + 1; });
  return c;
}
function defaultBrandSelection(counts) {
  // Major brands that actually have stations here are checked; unavailable ones
  // (count 0) are still shown as options but left unchecked. 'Other' off by default.
  const sel = new Set(BRAND_ORDER.filter(k => counts[k]));
  if (sel.size === 0 && counts.other) sel.add('other');   // all-independents area → don't show a blank map
  return sel;
}
/* ---- custom tooltip for "Other" brand chip ---- */
const _tip = (() => { const el = document.createElement('div'); el.className = 'brand-tip'; document.body.appendChild(el); return el; })();
let _tipHideTimer = null;
function showBrandTip(anchor, lines) {
  clearTimeout(_tipHideTimer);
  _tip.innerHTML = lines.map(l => `<div class="bt-row">${escapeHtml(l)}</div>`).join('');
  _tip.classList.add('visible');
  const r = anchor.getBoundingClientRect();
  _tip.style.left = r.left + 'px';
  _tip.style.top = (r.bottom + 8) + 'px';
}
function hideBrandTip() { _tipHideTimer = setTimeout(() => _tip.classList.remove('visible'), 80); }
function renderBrandFilter(reset) {
  const counts = brandCounts();
  if (reset || !state.brands) state.brands = defaultBrandSelection(counts);
  const keys = FILTER_KEYS;
  const wrap = document.getElementById('brandFilter');
  wrap.innerHTML = '';

  // "All" master toggle — checked when every group (all majors + Other) is on,
  // indeterminate when only some are. Clicking selects all, or clears all if already all.
  const allLbl = document.createElement('label');
  allLbl.className = 'bchk bchk-all';
  allLbl.innerHTML = `<input type="checkbox"><span class="bnm">All <span class="bcnt">(${DATA.length})</span></span>`;
  const allInput = allLbl.querySelector('input');
  allInput.addEventListener('change', () => {
    const allOn = keys.length > 0 && keys.every(k => state.brands.has(k));
    state.brands = new Set(allOn ? [] : keys);   // toggle select-all / select-none
    renderBrandFilter(false);                     // rebuild to resync every checkbox
    render();
  });
  wrap.appendChild(allLbl);

  const syncAll = () => {
    const on = keys.filter(k => state.brands.has(k)).length;
    allInput.checked = on === keys.length && keys.length > 0;
    allInput.indeterminate = on > 0 && on < keys.length;
    allLbl.classList.toggle('on', allInput.checked);
  };

  keys.forEach(k => {
    const on = state.brands.has(k);
    const lbl = document.createElement('label');
    lbl.className = 'bchk' + (on ? ' on' : '');
    lbl.innerHTML = `<input type="checkbox" ${on ? 'checked' : ''}>
      <span class="bdot" style="background:${k === 'other' ? OTHER.color : brandColor(k)}"></span>
      <span class="bnm">${escapeHtml(brandLabel(k))} <span class="bcnt">(${counts[k]})</span></span>`;
    if (k === 'other' && counts.other > 0) {
      const nameCounts = {};
      DATA.filter(s => s.brand === 'other').forEach(s => { nameCounts[s.name] = (nameCounts[s.name] || 0) + 1; });
      const tipLines = Object.entries(nameCounts).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} (${c})`);
      lbl.dataset.tip = tipLines.join('\n');
      lbl.addEventListener('mouseenter', e => showBrandTip(lbl, tipLines));
      lbl.addEventListener('mouseleave', hideBrandTip);
    }
    const input = lbl.querySelector('input');
    input.addEventListener('change', () => {
      if (input.checked) state.brands.add(k); else state.brands.delete(k);
      lbl.classList.toggle('on', input.checked);
      syncAll();
      render();
    });
    wrap.appendChild(lbl);
  });

  syncAll();
}

/* ===================== map init ===================== */
// zoomControl:false — the default +/- buttons sit top-left, fully hidden behind the
// toolbar card (only their corner poked out past its rounded edge, looking like a
// stray "beak"). Zoom still works via scroll / pinch / double-click.
const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([42.3795, -71.238], 13);
const IS_TOUCH = window.matchMedia('(hover: none), (pointer: coarse)').matches || navigator.maxTouchPoints > 0;
document.body.classList.toggle('is-touch', IS_TOUCH);   // CSS uses this to keep popups tappable on touch only
if (IS_TOUCH) map.on('click', () => map.closePopup());   // tapping empty map closes the open card

/* ===================== vector fallback geometry =====================
   Hand-traced local roads/river — rendered ONLY if every tile host is
   blocked. Safety net for the in-preview sandbox; not a primary basemap. */
const ROADS = { type: 'FeatureCollection', features: [
  // highway (I-95 / Rt-128) — western arc
  { type: 'Feature', properties: { kind: 'hwy' }, geometry: { type: 'LineString', coordinates: [[-71.2620, 42.3520], [-71.2720, 42.3650], [-71.2762, 42.3780], [-71.2742, 42.3905], [-71.2660, 42.4010], [-71.2540, 42.4090]] } },
  // Main St (Rt-20)
  { type: 'Feature', properties: { kind: 'major' }, geometry: { type: 'LineString', coordinates: [[-71.2050, 42.3748], [-71.2108, 42.3750], [-71.2302, 42.3774], [-71.2380, 42.3770], [-71.2433, 42.3764], [-71.2503, 42.3761], [-71.2600, 42.3766], [-71.2673, 42.3769], [-71.2760, 42.3772]] } },
  // Moody St
  { type: 'Feature', properties: { kind: 'major' }, geometry: { type: 'LineString', coordinates: [[-71.2393, 42.3590], [-71.2398, 42.3615], [-71.2410, 42.3660], [-71.2418, 42.3710], [-71.2433, 42.3764]] } },
  // Waverley Oaks Rd (Rt-60)
  { type: 'Feature', properties: { kind: 'major' }, geometry: { type: 'LineString', coordinates: [[-71.2110, 42.3690], [-71.2092, 42.3839], [-71.2068, 42.3935]] } },
  // Totten Pond Rd
  { type: 'Feature', properties: { kind: 'major' }, geometry: { type: 'LineString', coordinates: [[-71.2665, 42.3966], [-71.2585, 42.3972], [-71.2500, 42.3980], [-71.2415, 42.3986]] } },
  // Prospect St
  { type: 'Feature', properties: { kind: 'minor' }, geometry: { type: 'LineString', coordinates: [[-71.2452, 42.3640], [-71.2460, 42.3697], [-71.2463, 42.3737], [-71.2470, 42.3792]] } },
  // Lexington St
  { type: 'Feature', properties: { kind: 'minor' }, geometry: { type: 'LineString', coordinates: [[-71.2360, 42.3650], [-71.2362, 42.3764], [-71.2372, 42.3880], [-71.2384, 42.3980]] } },
  // Trapelo Rd stub (NW)
  { type: 'Feature', properties: { kind: 'minor' }, geometry: { type: 'LineString', coordinates: [[-71.2433, 42.3970], [-71.2380, 42.4040], [-71.2342, 42.4110]] } },
]};
const RIVER = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[-71.2585, 42.3650], [-71.2520, 42.3642], [-71.2460, 42.3656], [-71.2410, 42.3626], [-71.2360, 42.3616], [-71.2300, 42.3626], [-71.2250, 42.3600], [-71.2190, 42.3612]] } };
const styleFor = k => ({
  hwy:   { color: '#dcc285', weight: 7,   opacity: .9, lineCap: 'round' },
  major: { color: '#cbc5b8', weight: 4,   opacity: 1,  lineCap: 'round' },
  minor: { color: '#dad5ca', weight: 2.4, opacity: 1,  lineCap: 'round' },
}[k]);
function label(lat, lng, text, cls) {
  return L.marker([lat, lng], { interactive: false, zIndexOffset: -1000,
    icon: L.divIcon({ className: '', html: `<div class="${cls || 'maplabel'}">${text}</div>`, iconSize: [1, 1] }) });
}
const fallback = L.layerGroup([
  L.geoJSON(ROADS, { filter: f => f.properties.kind === 'hwy', style: { color: '#cdb27a', weight: 9, opacity: .55, lineCap: 'round' } }),
  L.geoJSON(ROADS, { style: f => styleFor(f.properties.kind) }),
  L.geoJSON(RIVER, { style: { color: '#bcd6e8', weight: 6, opacity: .95, lineCap: 'round' } }),
  label(42.3766, -71.2560, 'MAIN ST'), label(42.3690, -71.2415, 'MOODY ST'),
  label(42.3870, -71.2090, 'WAVERLEY OAKS'), label(42.3982, -71.2520, 'TOTTEN POND RD'),
  label(42.3640, -71.2470, 'CHARLES RIVER', 'maplabel river'), label(42.3905, -71.2735, 'I-95', 'ishield'),
]).addTo(map);

/* ===================== tiles (with host fallback) =====================
   1) CARTO Voyager  — closest free look to Google Maps (clean, light, friendly).
                       Needs CARTO_KEY (below); skipped when it's empty.
   2) Esri World Street — keyless; the default while there's no CARTO key
   3) OpenStreetMap  — busier; softened via CSS filter toward the Google palette
   4) vector net     — only if every host is blocked
   For a literal Google basemap in production, swap to the Google Maps JS API. */

/* CARTO basemap key. Since Sept 2026, CARTO answers EVERY tile request that has no
   valid key with the same "API KEY REQUIRED" watermark image (HTTP 200). Free for
   personal / non-commercial use (5M tiles/month): request one at
   https://carto.com/basemaps/apikey and paste it here. A tile key is public by
   nature — the browser fetches tiles directly and CARTO's terms forbid proxying
   them — so protect it with the restrictions in CARTO's dashboard, not by hiding it.
   Empty → CARTO is skipped and the map starts on Esri. */
const CARTO_KEY = 'cb1_5fl8_1_f1f134b92d308b9c71b7783a';

const STYLES = [
  { name: 'voyager', needsKey: true, filter: false, url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?key=' + encodeURIComponent(CARTO_KEY), sub: 'abcd', max: 18 /* keyed tiles stop at z18; z19+ → 403 (measured 2026-11-24) */, attr: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>' },
  { name: 'esri',    filter: false, url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', sub: 'abc', max: 19, attr: 'Tiles &copy; Esri' },
  { name: 'osm',     filter: true,  url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', sub: 'abc', max: 19, attr: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' },
].filter(s => !s.needsKey || CARTO_KEY);

/* A host that is up but refusing us can answer every request with one placeholder
   image and HTTP 200 (CARTO's "API KEY REQUIRED" watermark — also what a wrong or
   revoked key gets). Leaflet counts that as a successful load, so the error-based
   fallback in mountTiles() never fires and the watermark tiles across the map.
   Guard: fetch two tiles that differ on ANY real map (the whole world at z0 vs one
   quadrant at z1). Byte-identical → placeholder → skip the host. Inconclusive
   (network/CORS failure) → mount anyway and let the tile-error path decide. */
async function servesPlaceholder(s) {
  const at = (z, x, y) => L.Util.template(s.url, { s: s.sub[0], z, x, y, r: '' });
  try {
    const [a, b] = await Promise.all([at(0, 0, 0), at(1, 0, 0)].map(u => fetch(u).then(r => (r.ok ? r.arrayBuffer() : null))));
    if (!a || !b || a.byteLength !== b.byteLength) return false;
    const x = new Uint8Array(a), y = new Uint8Array(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  } catch (e) { return false; }
}

let styleIdx = 0, tiles = null, tilesLive = false;
async function mountTiles() {
  const s = STYLES[styleIdx];
  if (await servesPlaceholder(s)) {
    console.warn(`[tiles] ${s.name} is serving a placeholder image (missing/invalid key?) — skipping it`);
    if (styleIdx < STYLES.length - 1) { styleIdx++; mountTiles(); } else showMapBadge();
    return;
  }
  document.getElementById('map').classList.toggle('gmaps-soften', !!s.filter);
  tiles = L.tileLayer(s.url, { subdomains: s.sub, maxZoom: s.max, attribution: s.attr }).addTo(map);
  let err = 0;
  tiles.on('tileload', () => { if (tilesLive) return; tilesLive = true; if (map.hasLayer(fallback)) map.removeLayer(fallback); removeBadge(); });
  tiles.on('tileerror', () => {
    if (tilesLive) return;
    err++;
    if (err >= 3) {                                   // this host looks blocked → try the next style
      map.removeLayer(tiles);
      if (styleIdx < STYLES.length - 1) { styleIdx++; mountTiles(); }
      else showMapBadge();
    }
  });
}
function removeBadge() { const b = document.getElementById('mapBadge'); if (b) b.remove(); }
function showMapBadge() {
  if (tilesLive || document.getElementById('mapBadge')) return;
  const d = document.createElement('div'); d.id = 'mapBadge'; d.className = 'mapbadge';
  d.textContent = 'Tile hosts blocked in this preview — showing vector fallback. Real Google-style streets render once deployed.';
  document.body.appendChild(d);
}
mountTiles();
setTimeout(() => { if (!tilesLive) showMapBadge(); }, 4200);

/* ===================== origin marker (home or searched location) ===================== */
const HOME_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>';
const PIN_SVG  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>';
let originMarker = null;
function renderOrigin() {
  if (originMarker) map.removeLayer(originMarker);
  const html = origin.isHome
    ? `<div class="homepin"><div class="h">${HOME_SVG}</div><div class="lbl">HOME</div></div>`
    : `<div class="locpin"><div class="h">${PIN_SVG}</div></div>`;
  originMarker = L.marker([origin.lat, origin.lng], { icon: L.divIcon({ className: '', iconSize: [40, 46], iconAnchor: [20, 38], html }) }).addTo(map);
}

/* ===================== station markers + popups ===================== */
const markerLayer = L.layerGroup().addTo(map);
const markerById = {};

function popupHTML(s) {
  const a = ageInfo(updOf(s, state.grade));
  const grades = GORD.map(g => { const v = priceOf(s, g); return `<div class="gc ${g === state.grade ? 'act' : ''}"><div class="g">${GLAB[g]}</div><div class="v ${v == null ? 'none' : ''}">${v == null ? 'N/A' : '$' + v.toFixed(2)}</div></div>`; }).join('');
  const openTxt = s.openNow == null ? '' : ` · ${s.openNow ? 'Open' : 'Closed'}`;  // unknown (searched stations) → omit
  return `<div class="pop"><div class="ph">${brandImg(s.brand, 'bdg')}<span class="nm">${escapeHtml(s.name)}</span></div>
    <div class="meta">${s.distanceMi.toFixed(2)} mi${openTxt} <span class="fb ${a.cls}"><span class="d"></span>${a.label}</span></div>
    <div class="gr">${grades}</div>
    <a class="nav" href="${s.mapsUrl}" target="_blank" rel="noopener">NAVIGATE →</a></div>`;
}

// On mobile, tapping a pin re-centers the map so the open popup lands in the
// middle of the space BELOW the toolbar — not wherever it happens to fall
// otherwise, which was landing right under/behind the toolbar. Desktop hover is
// untouched: re-centering the map on every hover would be disruptive for a mouse
// user, so this only runs for the tap-to-open (IS_TOUCH) path, and only at
// mobile widths (matches the toolbar's own @media(max-width:640px) breakpoint).
// Movement style is flyTo — same as the rest of the app (search, edge chips): a
// short smooth glide when the popup is nearby, and an automatic
// zoom-out→travel→zoom-in arc when the target is far for the current zoom.
// `targetZoom` lets the edge-chip path fold its zoom bump into this SAME flight —
// one movement total, instead of "fly to pin, popup opens, second slide to
// center it" (that trailing slide read as a forced scroll).
function centerPopupOnMobile(marker, targetZoom) {
  if (!window.matchMedia('(max-width:640px)').matches) return;
  requestAnimationFrame(() => {
    const pop = marker.getPopup();
    const el = pop && pop.getElement();
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const toolbar = document.querySelector('.topbar');
    const topInset = toolbar ? toolbar.getBoundingClientRect().bottom : 0;
    const z = targetZoom == null ? map.getZoom() : targetZoom;
    const popC = L.point(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const safeC = L.point(window.innerWidth / 2, (topInset + window.innerHeight - chatBottomInset()) / 2);
    if (z === map.getZoom() && Math.abs(popC.x - safeC.x) <= 2 && Math.abs(popC.y - safeC.y) <= 2) return;
    // Solve at the TARGET zoom: the popup card is DOM-sized (it doesn't scale
    // with the map), so its center keeps a fixed pixel vector from the marker.
    // Find the map center that lands the popup on the safe-area center.
    const mp = map.latLngToContainerPoint(marker.getLatLng());  // pin's on-screen position
    const v = popC.subtract(mp);                                // marker → popup center
    const markerDst = safeC.subtract(v);                        // where the marker must land
    const centerPt = map.project(marker.getLatLng(), z).subtract(markerDst.subtract(map.getSize().divideBy(2)));
    const target = map.unproject(centerPt, z);
    const distPx = popC.distanceTo(safeC);
    // Branch on whether the PIN is visible, not just on zoom: an off-screen pin
    // should always get the travel flight, even when the zoom is already >= 14.
    const pinOnScreen = mp.x >= 0 && mp.x <= window.innerWidth && mp.y >= topInset && mp.y <= window.innerHeight;
    if (z === map.getZoom() && pinOnScreen) {
      // Same-zoom, ON-SCREEN hop → FLAT PAN, like Google Maps' short recenter.
      // flyTo's van-Wijk arc dips the zoom mid-flight even when start==end zoom
      // (measured: 13 → 12.989 → 13 on a 98px hop), so every frame renders at a
      // fractional zoom — tiles rescale and pin/popup positions re-round per
      // frame, which shows up as screen shake. panTo is one GPU translate of the
      // map pane: nothing rescales, nothing shakes. Short distance-scaled beat.
      map.panTo(target, { duration: Math.min(0.8, 0.4 + distPx / 1500), easeLinearity: 0.25 });
    } else {
      // Off-screen pin and/or zoom change (edge chips) → the Google-style travel
      // arc: zoom out → glide → zoom back in. Pacing: relaxed floor +
      // screen-distance + a beat per zoom level, capped at 1.6s.
      const dz = Math.abs(z - map.getZoom());
      map.flyTo(target, z, { duration: Math.min(1.6, 0.8 + distPx / 2000 + dz * 0.25) });
    }
  });
}

function drawMarkers() {
  markerLayer.clearLayers();
  for (const k in markerById) delete markerById[k];   // drop refs to the previous set
  const best = cheapest();
  visible().forEach(s => {
    const p = priceOf(s, state.grade);
    const a = ageInfo(updOf(s, state.grade));
    const isBest = best && s.id === best.id;
    const fvar = ({ 'fb-fresh': 'fresh', 'fb-aging': 'aging', 'fb-stale': 'stale', 'fb-nodata': 'nodata' })[a.cls];
    const nm = `<span class="ptag-nm">${escapeHtml(brandLabel(s.brand))}</span>`;
    const tag = p == null
      ? `<div class="ptag nodata">${nm}<span class="ptag-price">N/A</span></div>`
      : `<div class="ptag ${s.brand}">${nm}<span class="ptag-price">$${p.toFixed(2)}</span></div>`;
    const bc = brandColor(s.brand);   // accent for known brands; '' for 'other' → CSS falls back to neutral
    const html = `<div class="pin fade-in ${s.brand} ${isBest ? 'best' : ''}"${bc ? ` style="--brand:${bc}"` : ''}>${isBest ? '<div class="crown">◆ CHEAPEST</div>' : ''}${tag}<div class="stem"></div><div class="base"></div></div>`;
    const m = L.marker([s.lat, s.lng], { icon: L.divIcon({ className: '', iconSize: [72, 52], iconAnchor: [36, 52], html }), riseOnHover: true, zIndexOffset: isBest ? 1000 : 0 });
    const pop = L.popup({ closeButton: IS_TOUCH, offset: [0, -30], autoPan: false }).setContent(popupHTML(s));
    m.bindPopup(pop);
    if (IS_TOUCH) {
      // touch devices have no hover state: tap a pin opens it, tapping elsewhere/the map closes it
      m.on('click', (ev) => { L.DomEvent.stopPropagation(ev); map.closePopup(); m.openPopup(); centerPopupOnMobile(m); });
    } else {
      // Hover: dwell-to-open + grace-to-close bridge (see helpers below). Bound to
      // the visible chip; the popup card cancels the close on enter so it stays
      // reachable (read it / click NAVIGATE) and clustered pins don't strobe.
      m.on('add', () => {
        const chip = m.getElement() && m.getElement().querySelector('.ptag');
        if (!chip) return;
        chip.addEventListener('mouseenter', () => scheduleHoverOpen(m));
        chip.addEventListener('mouseleave', () => { cancelHoverOpen(); scheduleClose(); });
      });
      pop.on('add', () => {
        applyLogoFallbacks(pop.getElement());
        const card = pop.getElement() && pop.getElement().querySelector('.leaflet-popup-content-wrapper');
        if (card) {
          card.addEventListener('mouseenter', cancelPendingClose);
          card.addEventListener('mouseleave', scheduleClose);
        }
      });
    }
    m.addTo(markerLayer); markerById[s.id] = m;
  });
  // next frame: trigger the CSS transition so new pins fade/settle in, with a
  // small per-pin stagger (capped) for a fluid cascade instead of a flat pop-in
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      document.querySelectorAll('.pin.fade-in').forEach((el, i) => {
        el.style.transitionDelay = Math.min(i, 10) * 9 + 'ms';
        el.classList.add('show');
        el.addEventListener('transitionend', () => { el.style.transitionDelay = ''; }, { once: true });
      });
    });
  });
}

let fadeTimer = null;
function renderMarkers() {
  // crossfade: fade the current pins out, then swap the marker set in and fade the new ones in
  const current = document.querySelectorAll('#map .pin');
  if (!current.length) { drawMarkers(); return; }
  clearTimeout(fadeTimer);
  current.forEach(el => { el.style.transitionDelay = '0ms'; el.style.transition = 'opacity .07s ease, transform .07s ease'; el.style.opacity = '0'; el.style.transform = 'translateY(5px) scale(.92)'; });
  fadeTimer = setTimeout(drawMarkers, 65);
}

/* ---- hover card interaction (dwell-to-open + grace-to-close bridge) ----
   Open only after a short dwell, so quick fly-bys over clustered pins don't strobe
   the popup. Once open, a grace window lets the cursor travel from the pin onto the
   popup card (to read it / click NAVIGATE) without it closing: entering the card
   cancels the pending close, leaving both the pin and the card schedules it. */
// Snappier on desktop: short dwell so the card appears promptly (NN/g: responses
// under ~100ms read as instant; dwell 40 + fade start ≈ within that), shorter
// grace so it doesn't visibly linger after the cursor leaves. Dwell kept non-zero
// so a fast fly-by across clustered pins still doesn't strobe, and 80ms grace
// lets the cursor cross the ~17px pin→card gap before close (the card's
// mouseenter cancels the pending close). Anti-flicker otherwise comes from
// structure — geometry-safe hover + non-interactive tip — not timing.
const HOVER_OPEN_MS = 40, HOVER_CLOSE_MS = 80;
let hoverOpenTimer = null, closeTimer = null, hoverMarker = null;
function cancelHoverOpen() { clearTimeout(hoverOpenTimer); hoverOpenTimer = null; }
function cancelPendingClose() { clearTimeout(closeTimer); closeTimer = null; }
function scheduleHoverOpen(m) {
  cancelPendingClose();
  cancelHoverOpen();
  hoverOpenTimer = setTimeout(() => { hoverMarker = m; m.openPopup(); }, HOVER_OPEN_MS);
}
function scheduleClose() {
  cancelPendingClose();
  closeTimer = setTimeout(() => { if (hoverMarker) hoverMarker.closePopup(); }, HOVER_CLOSE_MS);
}

map.on('popupopen', e => {
  if (IS_TOUCH) applyLogoFallbacks(e.popup.getElement());   // non-touch path wires this itself via pop.on('add')
  // Leaflet reuses the popup container across opens — clear the exit-speed class
  // so the ENTRANCE runs on its own (longer, ease-out) transition. See styles.css.
  const el = e.popup.getElement();
  if (el) el.classList.remove('pop-closing');
});

// Exits are faster than entrances (Material motion): tag the popup at close time
// so CSS can give the fade-OUT its own short accelerate transition. This fires
// synchronously inside the close call — same style pass as Leaflet's opacity=0 —
// so the fast exit applies to every close path (hover-out, tap map, autoClose
// when another popup opens).
map.on('popupclose', e => {
  const el = e.popup.getElement();
  if (el) el.classList.add('pop-closing');
});

/* ===================== off-screen station indicators ===================== */
// Safe viewport box for edge chips: hug the REAL screen edges (small margin).
// The floating toolbar is NOT a full-width inset — on desktop it only covers the
// top-left, so a global 150px top inset left chips dangling on an invisible line
// with empty map above them. Instead the toolbar (and home group) are treated as
// occluder RECTANGLES, measured each update: a station whose pin sits behind one
// counts as off-screen (you can't see it) and gets a chip, and any chip that
// would land under one is dropped to just below it. On mobile the toolbar spans
// the full width, so this also fixes stations hidden under it having no chip.
const EDGE_INSET = { top: 12, bottom: PAD.bottom, left: 12, right: 12 };
function rectsOf(sels) {
  const rects = [];
  for (const sel of sels) {
    document.querySelectorAll(sel).forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width && r.height) rects.push(r);
    });
  }
  return rects;
}
// whole floating UI — chips never sit on it
function chipOccluders() { return rectsOf(['.topstack', '.home-float']); }
const edgeLayer = document.getElementById('edgeIndicators');
const edgeChips = new Map();   // station id -> { el, arrow, val, station } reusable chip

// Built once per station, then reused every frame — avoids per-move DOM churn.
// Positioned via TRANSFORM (left/top stay 0): updateEdgeIndicators runs every
// map-move frame, and left/top writes on absolute elements dirty layout, which
// turns the next frame's rect reads into full reflows — that thrash was the
// pan/zoom lag. Transform updates are compositor-only.
function makeEdgeChip() {
  const el = document.createElement('div');
  el.style.left = '0'; el.style.top = '0';
  el.style.transform = 'translate(-50%,-50%)';
  el.innerHTML = '<svg class="arrow" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2L4.5 20l7.5-4.2L19.5 20z"/></svg><span class="ec-val"></span>';
  const rec = { el, arrow: el.querySelector('.arrow'), val: el.querySelector('.ec-val'), station: null };
  el.addEventListener('click', () => { if (rec.station) setActiveFromEdge(rec.station); });
  return rec;
}

function updateEdgeIndicators() {
  if (!map) return;
  const size = map.getSize();
  // the open chat panel shrinks the box: pins under it count as off-screen and
  // their chips park at its edge instead of underneath it
  const box = { left: EDGE_INSET.left, top: EDGE_INSET.top,
    right: size.x - Math.max(EDGE_INSET.right, chatRightInset() + 12),
    bottom: size.y - Math.max(EDGE_INSET.bottom, chatBottomInset() + 12) };
  const cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2;
  const occ = chipOccluders();
  const best = cheapest();
  const seen = new Set();
  const placed = [];   // this frame's chips; positioned in bulk after de-overlap

  // Keep a chip inside the box and off the toolbar/home group.
  // Also flags WHICH axis got clamped: the de-overlap pass must spread
  // edge-pinned chips along the free axis, or the clamp just snaps them back
  // (top-row chips pushed apart vertically re-collapse onto the edge line).
  // Chips for pins hidden BEHIND the UI (c.overUi) become direction chips
  // parked just OUTSIDE the covering card — on whichever of its right/bottom
  // edges is nearer the pin, preserving the pin's other coordinate (its
  // relative position along the bar). The edge is chosen ONCE per frame and
  // then enforced, so de-overlap shifts can't drag the chip back onto the card.
  function constrain(c) {
    // clamp by the chip's HALF-SIZE, not a fixed margin — a fixed 10px let
    // corner-clamped chips hang half off-screen (chips are ~72px wide)
    const hx = c.w / 2 + 2, hy = c.h / 2 + 2;
    let nx = Math.max(box.left + hx, Math.min(box.right - hx, c.cxp));
    let ny = Math.max(box.top + hy, Math.min(box.bottom - hy, c.cyp));
    c.pinnedX = nx !== c.cxp;
    c.pinnedY = ny !== c.cyp;
    if (!c.overUi) {
      occ.forEach(r => {
        if (nx > r.left - c.w / 2 && nx < r.right + c.w / 2 && ny < r.bottom + c.h / 2 + 10) { ny = r.bottom + c.h / 2 + 10; c.pinnedY = true; }
      });
    } else {
      if (!c.exitEdge) {
        // find the rect covering the pin (tag extent, same as the hidden test)
        const rr = occ.find(r => c.pt.x >= r.left - 30 && c.pt.x <= r.right + 30 &&
          ((c.pt.y >= r.top && c.pt.y <= r.bottom) || (c.pt.y - 26 >= r.top && c.pt.y - 26 <= r.bottom))) || occ[0];
        const rightFits = rr.right + c.w + 12 <= box.right;   // right exit stays on screen (false on mobile's full-width bar)
        c.exitEdge = (rightFits && rr.right - c.pt.x <= rr.bottom - c.pt.y) ? 'right' : 'bottom';
        c.exitRect = rr;
      }
      if (c.exitEdge === 'right') { nx = Math.max(nx, c.exitRect.right + hx + 6); c.pinnedX = true; }
      else { ny = Math.max(ny, c.exitRect.bottom + hy + 6); c.pinnedY = true; }
      // still clear the OTHER floating UI piece (e.g. a bottom exit from the
      // toolbar landing on the home group, or a right exit grazing it)
      occ.forEach(r => {
        if (nx > r.left - c.w / 2 && nx < r.right + c.w / 2 && ny < r.bottom + c.h / 2 + 10) { ny = r.bottom + c.h / 2 + 10; c.pinnedY = true; }
      });
    }
    if (ny > box.bottom - hy) { ny = box.bottom - hy; c.pinnedY = true; }
    c.cxp = nx; c.cyp = ny;
  }

  visible().forEach(s => {
    const pt = map.latLngToContainerPoint([s.lat, s.lng]);
    const inBox = pt.x >= box.left && pt.x <= box.right && pt.y >= box.top && pt.y <= box.bottom;
    // Hidden test samples the pin's VISUAL EXTENT, not just its anchor point:
    // the icon rises ~52px above the anchor and the price tag spans ~30px to
    // each side. A pin whose tag is clipped by the toolbar — vertically OR
    // horizontally (e.g. tag half-buried under the card's right edge) — is
    // unreadable and needs a chip, even though its anchor is on open map.
    const midY = pt.y - 26;
    const hiddenAt = (x, y) => occ.some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
    const behindUi = hiddenAt(pt.x, pt.y) || hiddenAt(pt.x, midY) || hiddenAt(pt.x - 30, midY) || hiddenAt(pt.x + 30, midY);
    if (inBox && !behindUi) return;  // genuinely visible: no chip
    let cxp, cyp;
    if (inBox) {
      // Pin is on-screen but covered by the toolbar/home group: start at the pin;
      // constrain() projects the chip out to the covering card's nearest
      // right/bottom edge, keeping the pin's other coordinate.
      cxp = pt.x; cyp = pt.y;
    } else {
      // direction from view-box center to the off-screen point, clamped to the box edge
      const angle = Math.atan2(pt.y - cy, pt.x - cx);
      const scaleX = (box.right - box.left) / 2 - 18, scaleY = (box.bottom - box.top) / 2 - 18;
      const t = Math.min(scaleX / Math.max(Math.abs(Math.cos(angle)), 1e-6), scaleY / Math.max(Math.abs(Math.sin(angle)), 1e-6));
      cxp = cx + Math.cos(angle) * t; cyp = cy + Math.sin(angle) * t;
    }

    const p = priceOf(s, state.grade);
    const isBest = best && s.id === best.id;
    // reuse this station's chip if it already exists — just reposition/relabel it
    let rec = edgeChips.get(s.id);
    if (!rec) { rec = makeEdgeChip(); edgeLayer.appendChild(rec.el); edgeChips.set(s.id, rec); }
    rec.station = s;
    // Write DOM only on CHANGE — this runs every map-move frame, and blind
    // className/text writes dirty layout, turning the size reads below into a
    // per-frame reflow storm (the pan/zoom lag). A content change also
    // invalidates the cached size.
    const cls = `edge-chip ${s.brand} ${isBest ? 'best' : ''}`;
    if (rec.cls !== cls) { rec.el.className = cls; rec.cls = cls; rec.size = null; }
    const bc = brandColor(s.brand);   // accent for known brands
    if (rec.bc !== bc) { rec.el.style.setProperty('--brand', bc); rec.bc = bc; }
    const txt = p == null ? 'N/A' : '$' + p.toFixed(2);
    if (rec.txt !== txt) { rec.val.textContent = txt; rec.txt = txt; rec.size = null; }
    const title = `${s.name} · ${s.distanceMi.toFixed(2)} mi — tap to view`;   // .title is plain text, no escaping
    if (rec.title !== title) { rec.el.title = title; rec.title = title; }
    seen.add(s.id);
    placed.push({ rec, pt, cxp, cyp, overUi: inBox });
  });

  // sizes: measure only chips whose content changed (offsetWidth forces a
  // reflow); steady-state pans/zooms measure nothing at all
  placed.forEach(c => {
    if (!c.rec.size) c.rec.size = { w: c.rec.el.offsetWidth || 80, h: c.rec.el.offsetHeight || 28 };
    c.w = c.rec.size.w; c.h = c.rec.size.h;
  });
  placed.forEach(constrain);

  // ---- de-overlap: chips stacked on the same spot hid each other, so you
  // couldn't tell how many stations were there or tap a specific one (worst on
  // mobile — no hover, fat pointer). Iteratively push overlapping pairs apart
  // along the axis of least penetration, re-constraining each round so nothing
  // escapes the box or slides back under the toolbar. ≤ a few dozen chips, so
  // the O(n²) pass is nothing.
  const GAP = 6;
  for (let iter = 0; iter < 24; iter++) {   // long single-edge columns converge slowest (~2 rounds per chip)
    let moved = false;
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i], b = placed[j];
      const dx = b.cxp - a.cxp, dy = b.cyp - a.cyp;
      const ox = (a.w + b.w) / 2 + GAP - Math.abs(dx);
      const oy = (a.h + b.h) / 2 + GAP - Math.abs(dy);
      if (ox <= 0 || oy <= 0) continue;             // not overlapping
      // axis: min penetration, EXCEPT chips pinned to an edge spread along it
      const preferX = (a.pinnedY || b.pinnedY) && !(a.pinnedX || b.pinnedX);
      const preferY = (a.pinnedX || b.pinnedX) && !(a.pinnedY || b.pinnedY);
      if (preferX || (!preferY && ox < oy)) { const s = (dx >= 0 ? 1 : -1) * ox / 2; a.cxp -= s; b.cxp += s; }
      else { const s = (dy >= 0 ? 1 : -1) * oy / 2; a.cyp -= s; b.cyp += s; }
      moved = true;
    }
    if (!moved) break;
    placed.forEach(constrain);
  }

  // Deterministic cleanup for chips sharing one edge: the pairwise pass stalls
  // when chips are pinned against BOTH an edge clamp and the toolbar floor
  // (every vertical push snaps back), leaving slight overlaps. Sort each edge
  // column top→bottom (row left→right) and enforce spacing directly.
  function sweep1D(members, posKey, dimKey, hi) {
    members.sort((a, b) => a[posKey] - b[posKey]);
    for (let i = 1; i < members.length; i++) {
      const need = (members[i - 1][dimKey] + members[i][dimKey]) / 2 + GAP;
      if (members[i][posKey] - members[i - 1][posKey] < need) members[i][posKey] = members[i - 1][posKey] + need;
    }
    const last = members[members.length - 1];
    const over = last[posKey] - (hi - last[dimKey] / 2 - 2);
    if (over > 0) members.forEach(m => { m[posKey] -= over; });   // slide chain back; constrain() re-floors if needed
  }
  // Cluster by POSITION, not by pinned flags — a chip already resting exactly
  // on the clamp line was never "moved" by it, so flags miss settled columns.
  function edgeClusters(coordKey) {
    const arr = [...placed].sort((a, b) => a[coordKey] - b[coordKey]);
    const out = []; let cur = [];
    arr.forEach(c => {
      if (cur.length && c[coordKey] - cur[cur.length - 1][coordKey] > 30) { if (cur.length > 1) out.push(cur); cur = []; }
      cur.push(c);
    });
    if (cur.length > 1) out.push(cur);
    return out;
  }
  edgeClusters('cxp').forEach(g => sweep1D(g, 'cyp', 'h', box.bottom));   // columns
  edgeClusters('cyp').forEach(g => sweep1D(g, 'cxp', 'w', box.right));    // rows
  placed.forEach(constrain);   // never let the sweep slide a chip back onto the UI

  // final write; arrow points from the chip's FINAL position toward the actual
  // station — exact even after clamps, occluder push-downs and de-overlap shifts.
  // A chip parked exactly ON its (UI-hidden) pin has no direction: point up at
  // the pin body, which rises above its anchor.
  placed.forEach(c => {
    const adx = c.pt.x - c.cxp, ady = c.pt.y - c.cyp;
    const deg = Math.round(Math.abs(adx) < 1 && Math.abs(ady) < 1 ? 0 : Math.atan2(ady, adx) * 180 / Math.PI + 90);
    // transform, not left/top: compositor-only, keeps layout clean between frames
    const tf = `translate(${Math.round(c.cxp)}px,${Math.round(c.cyp)}px) translate(-50%,-50%)`;
    if (c.rec.tf !== tf) { c.rec.el.style.transform = tf; c.rec.tf = tf; }
    if (c.rec.deg !== deg) { c.rec.arrow.style.transform = `rotate(${deg}deg)`; c.rec.deg = deg; }
  });

  // retire chips for stations now on-screen or no longer in the active set
  edgeChips.forEach((rec, id) => { if (!seen.has(id)) { rec.el.remove(); edgeChips.delete(id); } });

  // A station never shows BOTH its pin and a direction chip: while the toolbar
  // covers a pin (its chip is the readable, tappable stand-in), the pin itself
  // hides; it returns as soon as the chip retires (pan away / fly to it).
  // Truly off-screen stations aren't affected — their pins aren't visible anyway.
  const chipOwned = new Set(placed.filter(c => c.overUi).map(c => c.rec.station.id));
  for (const id in markerById) {
    const el = markerById[id].getElement();
    if (!el) continue;
    const want = chipOwned.has(id);
    if (el.classList.contains('chip-owned') !== want) el.classList.toggle('chip-owned', want);
  }
}

function setActiveFromEdge(s) {
  const mk = markerById[s.id];
  const z = Math.max(map.getZoom(), 14);
  if (mk && IS_TOUCH && window.matchMedia('(max-width:640px)').matches) {
    // ONE flight: open the popup while it's still off-screen (invisible), then
    // fly straight to the spot that centers the POPUP — zoom bump included.
    // The old fly-to-pin → moveend → open → re-center did a second vertical
    // slide after the popup appeared, which read as a forced scroll.
    map.closePopup();
    mk.openPopup();
    centerPopupOnMobile(mk, z);
    return;
  }
  map.flyTo([s.lat, s.lng], z, { duration: .55 });
  map.once('moveend', () => {
    if (mk) { if (IS_TOUCH) { mk.fire('click'); } else { mk.openPopup(); } }
  });
}

// Leaflet fires "move" many times per drag; coalesce into at most one recompute
// per animation frame so panning stays smooth.
let edgeRaf = null;
function scheduleEdgeUpdate() {
  if (edgeRaf) return;
  edgeRaf = requestAnimationFrame(() => { edgeRaf = null; updateEdgeIndicators(); });
}
map.on('move zoom moveend zoomend resize', scheduleEdgeUpdate);

/* ===================== controls ===================== */
function bindSeg(id, key) {
  document.getElementById(id).addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    state[key] = b.dataset[key];
    [...e.currentTarget.children].forEach(c => c.classList.toggle('on', c === b));
    render();
  });
}
bindSeg('gradeSeg', 'grade');   // brand is a multi-select checkbox group, built by renderBrandFilter()

/* ---- radius slider: value label + track fill live while dragging; one
   re-fetch on release ('change', not 'input' — dragging must not spam the
   stations API). --pct drives the CSS gradient that paints the filled track. ---- */
const radiusSlider = document.getElementById('radiusSlider');
const radiusValEl = document.getElementById('radiusVal');
const radiusLabel = mi => (Number.isInteger(mi) ? mi : mi.toFixed(1)) + ' mi';
function syncRadiusUI() {
  const mi = parseFloat(radiusSlider.value);
  radiusValEl.textContent = radiusLabel(mi);
  radiusValEl.classList.toggle('at-default', Math.abs(mi - RADIUS_DEFAULT_MI) < 0.001);
  const lo = parseFloat(radiusSlider.min), hi = parseFloat(radiusSlider.max);
  radiusSlider.style.setProperty('--pct', ((mi - lo) / (hi - lo) * 100).toFixed(2) + '%');
}
syncRadiusUI();
radiusSlider.addEventListener('input', syncRadiusUI);
radiusSlider.addEventListener('change', () => {
  radiusM = Math.round(parseFloat(radiusSlider.value) * MI_TO_M);
  goToPlace(origin);   // re-fetch the current place at the new radius (re-frames to fit)
});

// bounds covering the origin + every active station — reused for framing and the home button
const currentBounds = () => L.latLngBounds([...DATA.map(s => [s.lat, s.lng]), [origin.lat, origin.lng]]);

/* ---- toolbar card: reflect the current origin + active set ---- */
function setLocationUI() {
  const nameEl = document.getElementById('locName');
  nameEl.textContent = origin.label || '—';
  nameEl.title = origin.fullLabel || origin.label || '';
  syncSearchClear();   // ✕ shows only when there's search text to clear
}
const setStamp = txt => { document.getElementById('syncStamp').textContent = txt; };

/* ---- data-freshness stamp: how recent the price data is ----
   Shows the age of the most recently updated price among the visible stations
   ("updated 1h ago"), color-coding the live dot fresh/aging/stale. Searched
   stations have no prices, so it honestly reads "no price data" (dot greyed). */
const FRESH_COLOR = { 'fb-fresh': 'var(--fresh)', 'fb-aging': 'var(--aging)', 'fb-stale': 'var(--stale)', 'fb-nodata': 'var(--nodata)' };
function updateFreshness() {
  let newest = null;
  visible().forEach(s => s.fuelPrices.forEach(p => {
    const t = new Date(p.updateTime).getTime();
    if (!Number.isNaN(t) && (newest == null || t > newest)) newest = t;
  }));
  const dot = document.querySelector('.live-dot');
  if (newest == null) {
    setStamp('no price data');
    if (dot) dot.style.setProperty('--dot', 'var(--nodata)');
    return;
  }
  const a = ageInfo(new Date(newest).toISOString());
  setStamp('Updated ' + a.label);
  if (dot) dot.style.setProperty('--dot', FRESH_COLOR[a.cls] || 'var(--fresh)');
}

/* ---- swap the active station set + origin, then redraw and re-frame ---- */
function setActiveSet(stations, newOrigin, { frame = true } = {}) {
  DATA = stations;
  origin = newOrigin;
  renderBrandFilter(true);      // rebuild brand checkboxes for the new area (majors on, Other off)
  setLocationUI();
  renderOrigin();
  render();                     // crossfade markers + recompute edge chips + freshness stamp
  if (frame) {
    if (stations.length) map.flyToBounds(currentBounds(), { paddingTopLeft: [PAD.side, framePadTop()], paddingBottomRight: [PAD.side + chatRightInset(), PAD.bottom + chatBottomInset()], duration: .6, maxZoom: 16 });
    else map.flyTo([origin.lat, origin.lng], 14, { duration: .6 });
  }
}

/* ===================== location search =====================
   The actual provider calls (geocode + nearby stations) live in services.js
   (window.FuelServices), the single external-data boundary. This section is just
   the UI orchestration around them: busy state, status stamp, error toast, and
   swapping the active set. Searched stations carry no prices yet, so they render
   in the honest "no data" state until the Google fuelOptions proxy is wired in. */

function setBusy(b) {
  document.getElementById('searchInput').disabled = b;
  document.getElementById('searchForm').classList.toggle('busy', b);
}
function flash(msg) {
  const old = document.getElementById('searchToast'); if (old) old.remove();
  const t = document.createElement('div'); t.id = 'searchToast'; t.className = 'mapbadge'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { if (t.parentNode) t.remove(); }, 3600);
}

async function runSearch(query) {
  const q = (query || '').trim();
  if (!q) return;
  setBusy(true); setStamp('searching…');
  try {
    const place = await FuelServices.geocode(q);
    if (!place) { flash(`No place found for “${q}”.`); updateFreshness(); return; }
    setStamp('finding stations…');
    const stations = await FuelServices.findStationsNear(place.lat, place.lng, radiusM);
    if (!stations.length) flash(`No gas stations found near ${place.label}.`);
    setActiveSet(stations, { lat: place.lat, lng: place.lng, label: place.label, fullLabel: place.full, isHome: false });
    document.getElementById('searchInput').value = ''; syncSearchClear();   // search done → empty the box
  } catch (err) {
    console.error('[search]', err);
    // A blocked/failed fetch throws a TypeError ("Failed to fetch"). The most
    // common cause here is opening index.html directly (file://), where browsers
    // block requests to outside services. Serving over http:// fixes it.
    const networkBlocked = err instanceof TypeError;
    flash(networkBlocked
      ? 'Can’t reach the search service. If you opened the file directly, run it from a local web server (see README — use the included start script).'
      : `Search failed: ${err.message}`);
    updateFreshness();
  } finally {
    setBusy(false);
  }
}

/* ===================== home + current location =====================
   Home is settable and saved on THIS device (localStorage). Until one is set, the
   home chip is disabled and the app seeds with the original Waltham default so the
   map isn't empty. The bottom-right button is now "stations near me" (device GPS). */
const HOME_KEY = 'fuelHome';
function loadHome() { try { return JSON.parse(localStorage.getItem(HOME_KEY)); } catch (e) { return null; } }
function saveHome(h) { try { localStorage.setItem(HOME_KEY, JSON.stringify(h)); } catch (e) {} }
let savedHome = loadHome();   // { lat, lng, label, full } or null

// Origin for the home location: the saved one, else the Waltham default seed.
function homeOrigin() {
  return savedHome
    ? { lat: savedHome.lat, lng: savedHome.lng, label: savedHome.label, fullLabel: savedHome.full || savedHome.label, isHome: true }
    : { lat: HOME.lat, lng: HOME.lng, label: 'Hope Ave', fullLabel: '60 Hope Ave, Waltham, MA', isHome: true };
}
function renderHomeChip() {
  const go = document.getElementById('homeGo'), label = document.getElementById('homeLabel');
  // Chip shows just "Home"; the full saved address is the hover (system) tooltip.
  if (savedHome) { go.disabled = false; label.textContent = 'Home'; go.title = savedHome.full || savedHome.label || 'Home'; }
  else { go.disabled = true; label.textContent = 'No home set'; go.title = 'Set a home address first (✎)'; }
}

// Fetch stations near an origin and swap the view. Shared by home / search-clear /
// "near me" / setting a new home.
async function goToPlace(o) {
  setBusy(true); setStamp('finding stations…');
  try {
    const stations = await FuelServices.findStationsNear(o.lat, o.lng, radiusM);
    if (!stations.length) flash(`No gas stations found near ${o.label}.`);
    setActiveSet(stations, o);
  } catch (err) {
    console.error('[goToPlace]', err);
    flash('Couldn’t load stations there. Check your connection and try again.');
    updateFreshness();
  } finally { setBusy(false); }
}

// "Stations near me" — device geolocation → nearby stations + a friendly label.
async function locateMe() {
  setBusy(true); setStamp('finding your location…');
  let pos;
  try { pos = await FuelServices.getCurrentPosition(); }
  catch (err) {
    setBusy(false);
    flash(err && err.code === 1
      ? 'Location permission denied — allow location access to find stations near you.'
      : 'Couldn’t get your location. Try again, or search instead.');
    updateFreshness();
    return;
  }
  const rev = await FuelServices.reverseGeocode(pos.lat, pos.lng);
  setBusy(false);
  document.getElementById('searchInput').value = '';
  goToPlace({ lat: pos.lat, lng: pos.lng, label: rev ? rev.label : 'Current location', fullLabel: rev ? rev.full : 'Your current location', isHome: false });
}

// Set / change the saved home address — a screen-level modal (opened by the gear).
function syncHomeInputClear() {
  const inp = document.getElementById('homeInput');
  document.getElementById('homeInputClear').hidden = !inp.value;
}
function openHomeEditor() {
  const modal = document.getElementById('homeModal'), inp = document.getElementById('homeInput');
  modal.hidden = false;
  inp.value = savedHome ? (savedHome.full || savedHome.label) : '';
  inp.focus();
  // No default highlight; caret at the start so the field shows the beginning
  // of a long address rather than scrolling to its end.
  inp.setSelectionRange(0, 0); inp.scrollLeft = 0;
  syncHomeInputClear();
}
function closeHomeEditor() { document.getElementById('homeModal').hidden = true; }
async function submitHome(q) {
  const text = (q || '').trim(); if (!text) return;
  const inp = document.getElementById('homeInput'); inp.disabled = true;
  try {
    const place = await FuelServices.geocode(text);
    if (!place) { flash(`Couldn’t find “${text}”.`); return; }
    savedHome = { lat: place.lat, lng: place.lng, label: place.label, full: place.full };
    saveHome(savedHome);
    renderHomeChip();
    closeHomeEditor();
    document.getElementById('searchInput').value = '';
    goToPlace(homeOrigin());
  } catch (err) {
    console.error('[setHome]', err);
    flash('Couldn’t set home (search service error).');
  } finally { inp.disabled = false; }
}

// The ✕ just clears the search text — it does NOT move the map. The current view
// and results stay exactly where they are; only the text box is emptied.
function syncSearchClear() {
  const inp = document.getElementById('searchInput');
  document.getElementById('searchClear').hidden = !inp.value;
}
document.getElementById('searchForm').addEventListener('submit', e => { e.preventDefault(); runSearch(document.getElementById('searchInput').value); });
document.getElementById('searchInput').addEventListener('input', syncSearchClear);
document.getElementById('searchClear').addEventListener('click', () => { const inp = document.getElementById('searchInput'); inp.value = ''; syncSearchClear(); inp.focus(); });
document.getElementById('locateBtn').addEventListener('click', locateMe);
document.getElementById('homeGo').addEventListener('click', () => { if (!savedHome) return; document.getElementById('searchInput').value = ''; syncSearchClear(); goToPlace(homeOrigin()); });
document.getElementById('homeEdit').addEventListener('click', openHomeEditor);
document.getElementById('homeCancel').addEventListener('click', closeHomeEditor);
document.getElementById('homeModalClose').addEventListener('click', closeHomeEditor);   // backdrop click
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !document.getElementById('homeModal').hidden) closeHomeEditor(); });
document.getElementById('homeInput').addEventListener('input', syncHomeInputClear);
document.getElementById('homeInputClear').addEventListener('click', () => { const inp = document.getElementById('homeInput'); inp.value = ''; syncHomeInputClear(); inp.focus(); });
document.getElementById('homeEditForm').addEventListener('submit', e => { e.preventDefault(); submitHome(document.getElementById('homeInput').value); });

/* ===================== map chat (LLM assistant) =====================
   A chat panel (bottom-right) that sends the conversation + a snapshot of what's
   on the map to /api/chat (via FuelServices.chat). The server runs the LLM tool
   loop and returns { reply, actions }; this section applies the actions with the
   SAME functions the manual controls use (setActiveSet, grade/brand state,
   popups), so the chat drives the map exactly like a user would.
   Passcode: the server requires one (keeps the public URL from running up the
   OpenAI bill). Saved per device in localStorage after the first successful use. */
const CHAT_PASS_KEY = 'fuelChatPass';
const chatEls = {
  fab: document.getElementById('chatToggle'), panel: document.getElementById('chatPanel'),
  close: document.getElementById('chatClose'), log: document.getElementById('chatLog'),
  form: document.getElementById('chatForm'), input: document.getElementById('chatInput'),
  send: document.getElementById('chatSend'),
  passForm: document.getElementById('chatPassForm'), pass: document.getElementById('chatPass'),
};
const chatHistory = [];   // [{ role: 'user'|'assistant', content }] — text turns only
let chatPending = null;   // question waiting on a passcode
let chatBusy = false;
function getChatPass() { try { return localStorage.getItem(CHAT_PASS_KEY) || ''; } catch (e) { return ''; } }
function setChatPass(v) { try { v ? localStorage.setItem(CHAT_PASS_KEY, v) : localStorage.removeItem(CHAT_PASS_KEY); } catch (e) {} }

function chatBubble(role, text) {
  const hint = chatEls.log.querySelector('.chat-hints'); if (hint) hint.remove();
  const d = document.createElement('div');
  d.className = 'chat-msg ' + role;   // user | assistant | note | thinking
  d.textContent = text;
  chatEls.log.appendChild(d);
  chatEls.log.scrollTop = chatEls.log.scrollHeight;
  return d;
}
function setChatOpen(open) {
  chatEls.panel.hidden = !open;
  chatEls.fab.hidden = open;
  chatEls.fab.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('chat-open', open);   // CSS hides the locate button under the phone sheet
  if (open) { (chatEls.passForm.hidden ? chatEls.input : chatEls.pass).focus(); }
  scheduleEdgeUpdate();   // the panel changes the free map area
}
function setChatPeek(on) {
  if (chatEls.panel.classList.contains('peek') === on) return;
  chatEls.panel.classList.toggle('peek', on);
  chatEls.log.scrollTop = chatEls.log.scrollHeight;
  scheduleEdgeUpdate();
}
function setChatBusy(b) {
  chatBusy = b;
  chatEls.input.disabled = b; chatEls.send.disabled = b;
  chatEls.panel.classList.toggle('busy', b);
}

// Snapshot of what the user sees, so "zoom to the cheapest one" or "what about
// regular?" can be answered without a new search.
function mapContext() {
  return {
    place: origin.label, full_address: origin.fullLabel, center: { lat: +origin.lat.toFixed(5), lng: +origin.lng.toFixed(5) },
    radius_miles: +(radiusM / MI_TO_M).toFixed(1),
    grade_shown: state.grade,
    brands_shown: [...state.brands],
    stations: DATA.slice(0, 25).map(s => ({
      id: s.id, name: s.name, brand: s.brand, distance_mi: +s.distanceMi.toFixed(2), open_now: s.openNow,
      shown: state.brands.has(s.brand),
      prices: Object.fromEntries(GORD.map(g => [g, priceOf(s, g)]).filter(([, v]) => v != null)),
      newest_price_hours_old: s.fuelPrices.length ? Math.round((NOW - Math.max(...s.fuelPrices.map(p => Date.parse(p.updateTime)))) / 36e5) : null,
    })),
  };
}

function setGrade(g) {
  if (!GORD.includes(g)) return;
  state.grade = g;
  [...document.getElementById('gradeSeg').children].forEach(c => c.classList.toggle('on', c.dataset.grade === g));
  render();
}
// Open a station's card: in place if its pin is on screen, else fly to it.
function openStationCard(id) {
  const s = DATA.find(x => x.id === id);
  if (!s) return;
  if (!state.brands.has(s.brand)) { state.brands.add(s.brand); renderBrandFilter(false); drawMarkers(); updateEdgeIndicators(); }
  const mk = markerById[s.id];
  const el = mk && mk.getElement();
  const pt = map.latLngToContainerPoint([s.lat, s.lng]);
  const onScreen = el && !el.classList.contains('chip-owned') && pt.x > 0 && pt.y > 0 &&
    pt.x < map.getSize().x - chatRightInset() && pt.y < map.getSize().y - chatBottomInset();
  if (!onScreen) { setActiveFromEdge(s); return; }
  map.closePopup(); mk.openPopup();
  if (IS_TOUCH) centerPopupOnMobile(mk); else keepCardVisible(mk);
}
// Desktop: a card opened by the chat (not by hover) can land under the toolbar or
// the chat panel. Pan the map just enough to clear them — the card rides along
// with its pin (autoPan is off for hover cards on purpose, so do it by hand here).
function keepCardVisible(mk) {
  requestAnimationFrame(() => {
    const pop = mk.getPopup(), el = pop && pop.getElement();
    const card = el && el.querySelector('.leaflet-popup-content-wrapper');
    if (!card) return;
    const r = card.getBoundingClientRect();
    const maxR = window.innerWidth - chatRightInset() - 12, maxB = window.innerHeight - 12;
    let dx = 0, dy = 0;
    chipOccluders().forEach(o => {
      if (r.right > o.left && r.left < o.right && r.bottom > o.top && r.top < o.bottom) {
        const right = o.right + 12 - r.left, down = o.bottom + 12 - r.top;
        if (r.right + right <= maxR && right <= down) dx = Math.max(dx, right); else dy = Math.max(dy, down);
      }
    });
    if (r.right + dx > maxR) dx = maxR - r.right;      // clear the chat panel / right edge
    if (r.top + dy < 12) dy = 12 - r.top;               // top edge
    if (r.bottom + dy > maxB && r.top + dy > 12) dy = Math.max(12 - r.top, maxB - r.bottom);
    if (dx || dy) map.panBy([-dx, -dy], { duration: .35 });   // content moves by +dx,+dy
  });
}
// Run after the current map flight ends (or a fallback timeout if none is running).
function afterFlight(cb) {
  let done = false;
  const go = () => { if (!done) { done = true; cb(); } };
  map.once('moveend', go);
  setTimeout(go, 1200);
}

function applyChatActions(actions) {
  // Order matters: a new result set resets the brand filter, so show results
  // first, then apply filters/grade, then focus a station.
  const rank = { show_search_results: 0, set_brand_filter: 1, set_fuel_grade: 2, focus_station: 3 };
  const list = [...(actions || [])].sort((a, b) => (rank[a.type] ?? 9) - (rank[b.type] ?? 9));
  // Phones: the full chat sheet leaves too little map between it and the toolbar
  // for a station card (~194px), so shrink it to a "peek" (latest reply + input)
  // BEFORE framing — setActiveSet / popup centering measure the sheet's height.
  if (list.length && IS_MOBILE_W()) setChatPeek(true);
  let focusId = null, moved = false;
  for (const a of list) {
    if (a.type === 'show_search_results' && a.origin && Array.isArray(a.stations)) {
      const o = a.origin;
      const mi = Math.min(5, Math.max(0.5, +a.radius_miles || RADIUS_DEFAULT_MI));
      radiusSlider.value = mi; syncRadiusUI(); radiusM = Math.round(mi * MI_TO_M);
      const stations = a.stations.map(r => FuelServices.fromRaw(r, o.lat, o.lng)).sort((x, y) => x.distanceMi - y.distanceMi);
      document.getElementById('searchInput').value = ''; syncSearchClear();
      setActiveSet(stations, { lat: o.lat, lng: o.lng, label: o.label, fullLabel: o.label, isHome: false });
      moved = true;
      if (a.focus_station_id) focusId = a.focus_station_id;
    } else if (a.type === 'set_brand_filter' && Array.isArray(a.brands)) {
      state.brands = new Set(a.brands.filter(k => FILTER_KEYS.includes(k)));
      renderBrandFilter(false); render();
    } else if (a.type === 'set_fuel_grade') {
      setGrade(a.grade);
    } else if (a.type === 'focus_station') {
      focusId = a.station_id;
    }
  }
  // A grade/brand change re-renders the pins with a crossfade (old markers are
  // cleared ~65ms later by drawMarkers), which would close a card opened right
  // now — so open it after the redraw (or after the map flight, if one started).
  if (focusId) { if (moved) afterFlight(() => openStationCard(focusId)); else setTimeout(() => openStationCard(focusId), 150); }
}

// retry=true re-sends a question whose bubble is already shown (after a passcode prompt)
async function sendChat(text, retry = false) {
  const q = (text || '').trim();
  if (!q || chatBusy) return;
  if (!retry) chatBubble('user', q);
  if (!getChatPass()) { chatPending = q; chatEls.passForm.hidden = false; chatEls.pass.focus(); return; }
  chatPending = null;
  chatHistory.push({ role: 'user', content: q });
  const thinking = chatBubble('thinking', 'Thinking…');
  setChatBusy(true);
  try {
    const { status, data } = await FuelServices.chat({ passcode: getChatPass(), messages: chatHistory, map_context: mapContext() });
    thinking.remove();
    if (status === 401) {
      chatHistory.pop(); setChatPass(''); chatPending = q;
      chatBubble('note', 'That passcode didn’t work. Enter the chat passcode to continue.');
      chatEls.passForm.hidden = false; chatEls.pass.value = ''; chatEls.pass.focus();
      return;
    }
    if (status !== 200 || !data) {
      chatHistory.pop();
      chatBubble('note', 'The chat service didn’t answer' + (data && data.error ? ` (${data.error}${data.message ? ': ' + data.message : ''})` : ` (HTTP ${status})`) + '. Try again in a moment.');
      return;
    }
    chatHistory.push({ role: 'assistant', content: data.reply || '' });
    chatBubble('assistant', data.reply || '(no reply)');
    applyChatActions(data.actions);
  } catch (err) {
    thinking.remove(); chatHistory.pop();
    console.error('[chat]', err);
    chatBubble('note', 'Can’t reach the chat service. Check your connection and try again.');
  } finally {
    setChatBusy(false);
    // desktop: ready for the next question. Phones: leave focus off the input —
    // refocusing would reopen the keyboard and un-peek the sheet over the map.
    if (chatEls.passForm.hidden && !IS_MOBILE_W()) chatEls.input.focus();
  }
}

chatEls.fab.addEventListener('click', () => setChatOpen(true));
chatEls.close.addEventListener('click', () => setChatOpen(false));
chatEls.form.addEventListener('submit', e => {
  e.preventDefault();
  const t = chatEls.input.value; chatEls.input.value = '';
  if (IS_MOBILE_W()) chatEls.input.blur();   // drop the phone keyboard so the map shows
  sendChat(t);
});
chatEls.passForm.addEventListener('submit', e => {
  e.preventDefault();
  const v = chatEls.pass.value.trim(); if (!v) return;
  setChatPass(v); chatEls.passForm.hidden = true; chatEls.pass.value = '';
  if (chatPending) { const q = chatPending; chatPending = null; sendChat(q, true); }
  else chatEls.input.focus();
});
chatEls.log.addEventListener('click', e => {
  const b = e.target.closest('.chat-hint'); if (b) { sendChat(b.textContent); return; }
  setChatPeek(false);   // tap the peeking reply → full chat again
});
chatEls.panel.querySelector('.chat-head').addEventListener('click', e => { if (!e.target.closest('.chat-close')) setChatPeek(false); });
chatEls.input.addEventListener('focus', () => setChatPeek(false));

/* ===================== boot ===================== */
function render() { renderMarkers(); updateEdgeIndicators(); updateFreshness(); }

// Inject domain helpers into the services layer (keeps the brand registry + its
// colors here in the UI layer; services stays free of registry concerns).
FuelServices.configure({ classify: classifyBrand, distMi });

async function boot() {
  renderHomeChip();
  // Where to open:
  //   • a previously-saved home wins (returning user's explicit choice), else
  //   • FIRST OPEN → default to the user's current location (device GPS), else
  //   • if location is denied/unavailable → fall back to the Waltham default seed.
  if (savedHome) {
    origin = homeOrigin();
  } else {
    setStamp('finding your location…');
    try {
      const pos = await FuelServices.getCurrentPosition();
      const rev = await FuelServices.reverseGeocode(pos.lat, pos.lng);
      origin = { lat: pos.lat, lng: pos.lng, label: rev ? rev.label : 'Current location', fullLabel: rev ? rev.full : 'Your current location', isHome: false };
    } catch (e) {
      origin = homeOrigin();   // permission denied / unsupported → default seed
    }
  }
  try {
    DATA = await FuelServices.findStationsNear(origin.lat, origin.lng, radiusM);
  } catch (e) {
    // No fake-data fallback: show an explicit, honest failure rather than
    // sample prices that would read as live. Map stays empty; stamp → "no data".
    console.error('[boot] live prices unavailable:', e);
    DATA = [];
    flash('Couldn’t load live prices — the data service didn’t respond. Check your connection and try again shortly.');
  }
  renderBrandFilter(true);
  setLocationUI();
  renderOrigin();
  render();
  applyLogoFallbacks(document);   // catches the static brand buttons (incl. any that already failed)
  // frame everything nicely under the floating toolbar
  setTimeout(() => { map.invalidateSize(); map.fitBounds(currentBounds(), { paddingTopLeft: [PAD.side, framePadTop()], paddingBottomRight: [PAD.side, PAD.bottom] }); updateEdgeIndicators(); }, 140);
}
boot();

})();
