/* ============================================================
   Hope Ave Fuel — app logic
   ------------------------------------------------------------
   Organized into sections; behavior is identical to the original
   single-file build. Several behaviors here are deliberate and
   fragile — see DECISIONS.md before changing:
     • hover bridge (cancelPendingClose / scheduleClose, 220ms)
     • crossfade (renderMarkers -> drawMarkers)
     • off-screen edge-indicator angle math
     • locate button centers HOME with a toolbar pixel offset
     • tile-host fallback chain -> vector fallback
   Reads the data layer from window.FuelData (see data.js).
   ============================================================ */
(function () {
'use strict';

/* ===================== config / state ===================== */
const { NOW, HOME } = window.FuelData;

// The original 7 Hope Ave stations are the "home" set; DATA is the *active*
// set on screen, which the location search swaps out (and the home button
// restores). `origin` is the current reference point — home, or a searched place.
// HOME_STATIONS / DATA start empty and are populated asynchronously at boot()
// from the services layer (sample data today, a Google proxy fetch later).
let HOME_STATIONS = [];
let DATA = [];
let origin = { lat: HOME.lat, lng: HOME.lng, label: 'Hope Ave', fullLabel: '60 Hope Ave, Waltham, MA', isHome: true };

// Padding (px) reserved for the floating toolbar card when framing the map and
// placing off-screen chips. Card is taller now (search row), so top is larger.
const PAD = { top: 150, bottom: 40, side: 36 };

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
const map = L.map('map', { zoomControl: true, attributionControl: true }).setView([42.3795, -71.238], 13);
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
   1) CARTO Voyager  — closest free look to Google Maps (clean, light, friendly)
   2) Esri World Street
   3) OpenStreetMap  — busier; softened via CSS filter toward the Google palette
   4) vector net     — only if every host is blocked
   For a literal Google basemap in production, swap to the Google Maps JS API. */
const STYLES = [
  { name: 'voyager', filter: false, url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', sub: 'abcd', max: 20, attr: '&copy; OpenStreetMap &copy; CARTO' },
  { name: 'esri',    filter: false, url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', sub: 'abc', max: 19, attr: 'Tiles &copy; Esri' },
  { name: 'osm',     filter: true,  url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', sub: 'abc', max: 19, attr: '&copy; OpenStreetMap contributors' },
];
let styleIdx = 0, tiles = null, tilesLive = false;
function mountTiles() {
  const s = STYLES[styleIdx];
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
  const openTxt = s.openNow == null ? '' : ` · ${s.openNow ? 'open' : 'closed'}`;  // unknown (searched stations) → omit
  return `<div class="pop"><div class="ph">${brandImg(s.brand, 'bdg')}<span class="nm">${escapeHtml(s.name)}</span></div>
    <div class="meta">${s.distanceMi.toFixed(2)} mi${openTxt} <span class="fb ${a.cls}"><span class="d"></span>${a.label}</span></div>
    <div class="gr">${grades}</div>
    <a class="nav" href="${s.mapsUrl}" target="_blank" rel="noopener">NAVIGATE →</a></div>`;
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
      m.on('click', (ev) => { L.DomEvent.stopPropagation(ev); map.closePopup(); m.openPopup(); });
    } else {
      // Robust hover: bind mouseenter/mouseleave to the visible chip itself.
      // Unlike Leaflet's marker mouseover/mouseout (which bubble and refire on
      // every child/popup/stacking change — causing the popup to flicker or get
      // stuck closed), these fire only when the pointer truly crosses the chip's
      // border and ignore the popup that opens above it.
      m.on('add', () => {
        const chip = m.getElement() && m.getElement().querySelector('.ptag');
        if (!chip) return;
        chip.addEventListener('mouseenter', () => m.openPopup());
        chip.addEventListener('mouseleave', () => m.closePopup());
      });
      pop.on('add', () => applyLogoFallbacks(pop.getElement()));
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

/* ---- hover bridge: gives the cursor a grace window to travel from the pin to the popup card
   (e.g. to reach the Navigate button) without the popup closing out from under it ---- */
let closeTimer = null;
function cancelPendingClose() { clearTimeout(closeTimer); closeTimer = null; }
function scheduleClose(m) {
  cancelPendingClose();
  closeTimer = setTimeout(() => { m.closePopup(); }, 220);
}

map.on('popupopen', e => {
  if (IS_TOUCH) applyLogoFallbacks(e.popup.getElement());   // non-touch path wires this itself via pop.on('add')
});

/* ===================== off-screen station indicators ===================== */
// Safe viewport box, inset from the toolbar (top) and screen edges, matching the padding used elsewhere.
const EDGE_INSET = { top: PAD.top, bottom: PAD.bottom, left: PAD.side, right: PAD.side, margin: 14 };
const edgeLayer = document.getElementById('edgeIndicators');
const edgeChips = new Map();   // station id -> { el, arrow, val, station } reusable chip

// Built once per station, then reused every frame — avoids per-move DOM churn.
function makeEdgeChip() {
  const el = document.createElement('div');
  el.style.transform = 'translate(-50%,-50%)';
  el.innerHTML = '<svg class="arrow" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2L4.5 20l7.5-4.2L19.5 20z"/></svg><span class="ec-val"></span>';
  const rec = { el, arrow: el.querySelector('.arrow'), val: el.querySelector('.ec-val'), station: null };
  el.addEventListener('click', () => { if (rec.station) setActiveFromEdge(rec.station); });
  return rec;
}

function updateEdgeIndicators() {
  if (!map) return;
  const size = map.getSize();
  const box = { left: EDGE_INSET.left, top: EDGE_INSET.top, right: size.x - EDGE_INSET.right, bottom: size.y - EDGE_INSET.bottom };
  const cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2;
  const best = cheapest();
  const seen = new Set();

  visible().forEach(s => {
    const pt = map.latLngToContainerPoint([s.lat, s.lng]);
    if (pt.x >= box.left && pt.x <= box.right && pt.y >= box.top && pt.y <= box.bottom) return;  // on-screen: no chip
    // direction from view-box center to the off-screen point, clamped to the box edge
    const dx = pt.x - cx, dy = pt.y - cy;
    const angle = Math.atan2(dy, dx);
    // clamp the chip position to just inside the box edge, along that angle
    const scaleX = (box.right - box.left) / 2 - 18, scaleY = (box.bottom - box.top) / 2 - 18;
    const t = Math.min(scaleX / Math.max(Math.abs(Math.cos(angle)), 1e-6), scaleY / Math.max(Math.abs(Math.sin(angle)), 1e-6));
    let cxp = cx + Math.cos(angle) * t, cyp = cy + Math.sin(angle) * t;
    cxp = Math.max(box.left + 10, Math.min(box.right - 10, cxp));
    cyp = Math.max(box.top + 10, Math.min(box.bottom - 10, cyp));

    const p = priceOf(s, state.grade);
    const isBest = best && s.id === best.id;
    const arrowDeg = (angle * 180 / Math.PI) + 90; // point arrow outward toward the station

    // reuse this station's chip if it already exists — just reposition/relabel it
    let rec = edgeChips.get(s.id);
    if (!rec) { rec = makeEdgeChip(); edgeLayer.appendChild(rec.el); edgeChips.set(s.id, rec); }
    rec.station = s;
    rec.el.className = `edge-chip ${s.brand} ${isBest ? 'best' : ''}`;
    rec.el.style.setProperty('--brand', brandColor(s.brand));   // accent border for known brands
    rec.el.style.left = cxp + 'px'; rec.el.style.top = cyp + 'px';
    rec.arrow.style.transform = `rotate(${arrowDeg}deg)`;
    rec.val.textContent = p == null ? 'N/A' : '$' + p.toFixed(2);
    rec.el.title = `${s.name} · ${s.distanceMi.toFixed(2)} mi — tap to view`;   // .title is plain text, no escaping
    seen.add(s.id);
  });

  // retire chips for stations now on-screen or no longer in the active set
  edgeChips.forEach((rec, id) => { if (!seen.has(id)) { rec.el.remove(); edgeChips.delete(id); } });
}

function setActiveFromEdge(s) {
  map.flyTo([s.lat, s.lng], Math.max(map.getZoom(), 14), { duration: .55 });
  map.once('moveend', () => {
    const mk = markerById[s.id];
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

// bounds covering the origin + every active station — reused for framing and the home button
const currentBounds = () => L.latLngBounds([...DATA.map(s => [s.lat, s.lng]), [origin.lat, origin.lng]]);

/* ---- toolbar card: reflect the current origin + active set ---- */
function setLocationUI() {
  const nameEl = document.getElementById('locName');
  nameEl.textContent = origin.label || '—';
  nameEl.title = origin.fullLabel || origin.label || '';
  document.getElementById('searchClear').hidden = !!origin.isHome;
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
  setStamp('updated ' + a.label);
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
    if (stations.length) map.flyToBounds(currentBounds(), { paddingTopLeft: [PAD.side, PAD.top], paddingBottomRight: [PAD.side, PAD.bottom], duration: .6, maxZoom: 16 });
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
    const stations = await FuelServices.findStationsNear(place.lat, place.lng);
    if (!stations.length) flash(`No gas stations found near ${place.label}.`);
    setActiveSet(stations, { lat: place.lat, lng: place.lng, label: place.label, fullLabel: place.full, isHome: false });
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

/* ---- home: restore the original 7 and the deliberate home-centering recenter ---- */
function goHome() {
  document.getElementById('searchInput').value = '';
  setActiveSet(HOME_STATIONS, { lat: HOME.lat, lng: HOME.lng, label: 'Hope Ave', fullLabel: '60 Hope Ave, Waltham, MA', isHome: true }, { frame: false });
  // find the zoom that fits everything, but center HOME (not the bounds midpoint),
  // with a pixel shift to compensate for the toolbar's footprint. (See DECISIONS.md.)
  const fitZoom = map.getBoundsZoom(currentBounds(), false, L.point(PAD.side, PAD.top), L.point(PAD.side, PAD.bottom));
  const pxShift = (PAD.top - PAD.bottom) / 2;
  map.flyTo([HOME.lat, HOME.lng], fitZoom, { duration: .6 });
  map.once('moveend', () => { map.panBy([0, -pxShift], { animate: false }); });
}

document.getElementById('searchForm').addEventListener('submit', e => { e.preventDefault(); runSearch(document.getElementById('searchInput').value); });
document.getElementById('searchClear').addEventListener('click', goHome);
document.getElementById('locateBtn').addEventListener('click', goHome);

/* ===================== boot ===================== */
function render() { renderMarkers(); updateEdgeIndicators(); updateFreshness(); }

// Inject domain helpers into the services layer (keeps the brand registry + its
// colors here in the UI layer; services stays free of registry concerns).
FuelServices.configure({ classify: classifyBrand, distMi });

async function boot() {
  HOME_STATIONS = await FuelServices.getHomeStations();
  DATA = HOME_STATIONS;
  renderBrandFilter(true);
  setLocationUI();
  renderOrigin();
  render();
  applyLogoFallbacks(document);   // catches the static brand buttons (incl. any that already failed)
  // frame everything nicely under the floating toolbar
  setTimeout(() => { map.invalidateSize(); map.fitBounds(currentBounds(), { paddingTopLeft: [PAD.side, PAD.top], paddingBottomRight: [PAD.side, PAD.bottom] }); updateEdgeIndicators(); }, 140);
}
boot();

})();
