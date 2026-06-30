/* ============================================================
   SERVICES — external data provider / adapter layer
   ------------------------------------------------------------
   The SINGLE boundary between the app and the outside world.
   Every network / provider call lives here behind a small async
   interface, so the rest of the app never knows which backend is live.

   Backend: Google APIs via a same-origin serverless proxy (so the API key
   stays server-side — see api/geocode.js and api/stations.js). Because the
   proxy is same-origin (app + /api on one Vercel domain) there's no CORS to
   manage; fetch('/api/...') just works.
     • getHomeStations()  → /api/stations around HOME  (Places searchNearby + fuelOptions)
     • geocode()          → /api/geocode              (Geocoding API)
     • findStationsNear() → /api/stations             (Places searchNearby + fuelOptions)

   Returned shapes match DATA-SHAPE.md, so app.js / the UI need no changes.
   Domain helpers (the brand classifier and the distance function) are injected
   by app.js via configure(), keeping the brand registry and its colors in the
   UI layer; brand + distance are applied here in toStation().

   LOCAL DEV: opened via file:// or a plain static server, /api doesn't exist,
   so both the home load and search FAIL (throw) and the UI shows an explicit
   "couldn't load live prices" toast — it never shows fake prices as if real.
   Run `vercel dev` (or use the deployed URL) for live data.

   Loaded as a plain <script> AFTER data.js, BEFORE app.js (no build step, no ES
   modules). Exposes window.FuelServices.
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

  /* Map a raw proxy station (Google-derived) into the canonical app shape.
     Brand + distance are applied here so the brand registry stays in app.js. */
  function toStation(raw, oLat, oLng) {
    return {
      id: raw.id || `g-${raw.lat},${raw.lng}`,
      brand: _classify({ name: raw.name }),
      name: raw.name || 'Gas station',
      lat: raw.lat,
      lng: raw.lng,
      distanceMi: _distMi(oLat, oLng, raw.lat, raw.lng),
      openNow: raw.openNow == null ? null : raw.openNow,
      mapsUrl: raw.id
        ? `https://www.google.com/maps/search/?api=1&query=${raw.lat},${raw.lng}&query_place_id=${raw.id}`
        : `https://www.google.com/maps/search/?api=1&query=${raw.lat},${raw.lng}`,
      fuelPrices: Array.isArray(raw.fuelPrices) ? raw.fuelPrices : [],
    };
  }

  async function fetchNear(lat, lng, radiusM) {
    const r = await fetch(`/api/stations?lat=${lat}&lng=${lng}&radius=${radiusM}`);
    if (!r.ok) throw new Error('stations http ' + r.status);
    const raw = await r.json();
    return raw.map(s => toStation(s, lat, lng)).sort((a, b) => a.distanceMi - b.distanceMi);
  }

  /* ---- HOME STATIONS (with live prices) ----
     Throws on failure (no proxy / network error). The caller (app.js boot)
     catches it and shows an explicit "couldn't load live prices" toast — we
     deliberately do NOT fall back to the sample fixture, so stale/fake prices
     are never shown as if they were live. */
  async function getHomeStations() {
    return fetchNear(FD.HOME.lat, FD.HOME.lng, 4000);
  }

  /* ---- GEOCODE: query string → { lat, lng, label, full } | null ---- */
  async function geocode(q) {
    const r = await fetch('/api/geocode?q=' + encodeURIComponent(q));
    if (!r.ok) throw new Error('geocode http ' + r.status);
    return r.json();   // { lat, lng, label, full } or null
  }

  /* ---- NEARBY STATIONS: (lat,lng) → [station, …] sorted by distance ---- */
  async function findStationsNear(lat, lng, radiusM = 4000) {
    return fetchNear(lat, lng, radiusM);
  }

  /* ---- CURRENT LOCATION: device geolocation → { lat, lng } ----
     Browser-native (free, no key), but needs HTTPS and a one-time user permission.
     Rejects with the GeolocationPositionError (.code 1 = denied) so callers can
     show the right message. */
  function getCurrentPosition() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('geolocation unsupported'));
      navigator.geolocation.getCurrentPosition(
        p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        err => reject(err),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    });
  }

  /* ---- REVERSE GEOCODE: (lat,lng) → { lat,lng,label,full } | null ----
     For a friendly label on "near me" / a set-home pin. Best-effort; never throws. */
  async function reverseGeocode(lat, lng) {
    try {
      const r = await fetch('/api/geocode?latlng=' + encodeURIComponent(lat + ',' + lng));
      if (!r.ok) return null;
      return r.json();
    } catch (e) { return null; }
  }

  window.FuelServices = { configure, getHomeStations, geocode, findStationsNear, getCurrentPosition, reverseGeocode };
})();
