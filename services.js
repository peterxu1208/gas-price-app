/* ============================================================
   SERVICES — external data provider / adapter layer
   ------------------------------------------------------------
   The SINGLE boundary between the app and the outside world.
   Every network / provider call lives here behind a small async
   interface, so swapping the current keyless OpenStreetMap backend
   for Google APIs is a change to THIS FILE ONLY — the UI and logic
   in app.js never need to know which backend is live.

   Current backend (keyless, CORS-friendly, works from file://):
     • getHomeStations()  → sample data from data.js (window.FuelData)
     • geocode()          → OpenStreetMap Nominatim
     • findStationsNear() → OpenStreetMap Overpass (amenity=fuel)

   GOING LIVE WITH GOOGLE — each function below has a TODO(google)
   marking exactly what to replace. The returned shapes already match
   DATA-SHAPE.md / Google's fuelOptions, so callers don't change:
     • getHomeStations  → fetch('/api/prices') from your proxy
     • geocode          → Geocoding API (via proxy)
     • findStationsNear → Places API (New) searchNearby + fuelOptions (via proxy)

   Loaded as a plain <script> AFTER data.js, BEFORE app.js (no build
   step, no ES modules — still opens via file://). Exposes
   window.FuelServices. Domain helpers (the brand classifier and the
   distance function) are injected by app.js via configure(), keeping
   the brand registry and its colors in the UI layer where they belong.
   ============================================================ */
(function () {
  'use strict';
  const FD = window.FuelData;   // sample-data fixture (data.js)

  // Injected by app.js so this layer stays free of UI / registry concerns.
  let _classify = () => 'other';
  let _distMi = () => 0;
  function configure(opts) {
    if (opts && opts.classify) _classify = opts.classify;
    if (opts && opts.distMi)   _distMi = opts.distMi;
  }

  /* ---- HOME STATIONS (with prices) ----
     TODO(google): replace the body with
       const r = await fetch('/api/prices'); return r.json();
     keeping the DATA-SHAPE.md shape. */
  async function getHomeStations() {
    return FD.getStationData();
  }

  /* ---- GEOCODE: query string → { lat, lng, label, full } | null ----
     TODO(google): swap Nominatim for the Geocoding API (through your proxy
     so the key stays server-side). Map the response to the same
     { lat, lng, label, full } shape and nothing else changes. */
  function shortLabel(g) {
    const a = g.address || {};
    const primary = a.road || a.neighbourhood || a.suburb || a.hamlet || a.village || a.town || a.city || a.county || g.name;
    const city = a.city || a.town || a.village || a.county;
    if (primary && city && primary !== city) return `${primary}, ${city}`;
    return primary || (g.display_name || '').split(',').slice(0, 2).join(',').trim();
  }
  async function geocode(q) {
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=1&q=' + encodeURIComponent(q);
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('geocode http ' + r.status);
    const j = await r.json();
    if (!j.length) return null;
    const g = j[0];
    return { lat: +g.lat, lng: +g.lon, label: shortLabel(g), full: g.display_name };
  }

  /* ---- NEARBY STATIONS: (lat,lng) → [station, …] sorted by distance ----
     Searched stations have no keyless price source, so fuelPrices is [] and
     they render in the honest "no data" state.
     TODO(google): swap Overpass for Places API (New) searchNearby with the
     fuelOptions field mask (through your proxy). Map each result to the shape
     below — set fuelPrices from fuelOptions.fuelPrices — and the rest is unchanged. */
  function osmToStation(el, oLat, oLng) {
    const lat = el.lat != null ? el.lat : el.center && el.center.lat;
    const lng = el.lon != null ? el.lon : el.center && el.center.lon;
    if (lat == null || lng == null) return null;
    const t = el.tags || {};
    let openNow = null;
    if (t.opening_hours && t.opening_hours.trim() === '24/7') openNow = true;   // anything fancier is left unknown
    return {
      id: `osm-${el.type}-${el.id}`,
      brand: _classify(t),
      name: t.name || t.brand || t.operator || 'Gas station',
      lat, lng,
      distanceMi: _distMi(oLat, oLng, lat, lng),
      openNow,
      mapsUrl: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
      fuelPrices: [],   // no keyless price source — fills in once a Google proxy is added
    };
  }
  async function findStationsNear(lat, lng, radiusM = 4000) {
    const q = `[out:json][timeout:25];(node["amenity"="fuel"](around:${radiusM},${lat},${lng});way["amenity"="fuel"](around:${radiusM},${lat},${lng}););out center tags;`;
    const r = await fetch('https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(q));
    if (!r.ok) throw new Error('overpass http ' + r.status);
    const j = await r.json();
    return (j.elements || []).map(el => osmToStation(el, lat, lng)).filter(Boolean)
      .sort((a, b) => a.distanceMi - b.distanceMi);
  }

  window.FuelServices = { configure, getHomeStations, geocode, findStationsNear };
})();
