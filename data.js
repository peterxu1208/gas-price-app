/* ============================================================
   DATA LAYER
   ------------------------------------------------------------
   This is the swap seam for live data. To go live, replace the
   body of getStationData() with `return fetch('/api/prices').then(r=>r.json())`
   (and make callers await it) — keep the returned shape identical to
   DATA-SHAPE.md. Everything else (rendering, sorting, freshness badges,
   the "cheapest" crown, off-screen indicators) reads from that shape.

   Exposed on window.FuelData so app.js can consume it without a build step
   (plain <script> tags, no ES modules, still opens via file://).
   ============================================================ */
(function () {
  // Single page-load timestamp, shared with the freshness calc in app.js so
  // sample updateTimes and the "Xh ago" ages are measured from the same instant.
  const NOW = Date.now();
  const hoursAgo = h => new Date(NOW - h * 3600 * 1000).toISOString();

  const HOME = { lat: 42.3667, lng: -71.2452 };  // 60 Hope Ave, Waltham, MA 02453

  // Sample data, shaped to mirror Google Places API (New) `fuelOptions.fuelPrices[]`
  // ({type, price, updateTime}) so the live swap needs minimal reshaping.
  // NOTE: shell-totten has fuelPrices:[] on purpose — it exercises the honest
  // "no data" UI state. Do not invent a price for it. (See DATA-SHAPE.md.)
  function getStationData() {
    return [
      { id: 'mobil-moody', brand: 'mobil', name: 'Mobil — Moody St', lat: 42.361529, lng: -71.2393409, distanceMi: 0.45, openNow: true, mapsUrl: 'https://maps.google.com/?cid=14881663163525332119',
        fuelPrices: [{ type: 'REGULAR_UNLEADED', price: 3.05, updateTime: hoursAgo(5) }, { type: 'MIDGRADE', price: 3.45, updateTime: hoursAgo(5) }, { type: 'PREMIUM', price: 3.69, updateTime: hoursAgo(5) }, { type: 'DIESEL', price: 3.79, updateTime: hoursAgo(5) }] },
      { id: 'mobil-821', brand: 'mobil', name: 'Mobil — 821 Main', lat: 42.3764038, lng: -71.2432645, distanceMi: 0.70, openNow: true, mapsUrl: 'https://maps.google.com/?cid=9549478774968707600',
        fuelPrices: [{ type: 'REGULAR_UNLEADED', price: 2.99, updateTime: hoursAgo(9) }, { type: 'MIDGRADE', price: 3.39, updateTime: hoursAgo(9) }, { type: 'PREMIUM', price: 3.65, updateTime: hoursAgo(9) }] },
      { id: 'shell-962', brand: 'shell', name: 'Shell — 962 Main', lat: 42.3761049, lng: -71.2503023, distanceMi: 0.75, openNow: true, mapsUrl: 'https://maps.google.com/?cid=1105500229328553380',
        fuelPrices: [{ type: 'REGULAR_UNLEADED', price: 3.09, updateTime: hoursAgo(2) }, { type: 'MIDGRADE', price: 3.49, updateTime: hoursAgo(2) }, { type: 'PREMIUM', price: 3.75, updateTime: hoursAgo(2) }, { type: 'DIESEL', price: 3.85, updateTime: hoursAgo(2) }] },
      { id: 'mobil-1335', brand: 'mobil', name: 'Mobil — 1335 Main', lat: 42.3769446, lng: -71.2673431, distanceMi: 1.35, openNow: true, mapsUrl: 'https://maps.google.com/?cid=10439248539639312396',
        fuelPrices: [{ type: 'REGULAR_UNLEADED', price: 2.95, updateTime: hoursAgo(1) }, { type: 'MIDGRADE', price: 3.35, updateTime: hoursAgo(1) }, { type: 'PREMIUM', price: 3.59, updateTime: hoursAgo(1) }, { type: 'DIESEL', price: 3.69, updateTime: hoursAgo(1) }] },
      { id: 'shell-65', brand: 'shell', name: 'Shell — 65 Main', lat: 42.374998, lng: -71.210763, distanceMi: 1.85, openNow: false, mapsUrl: 'https://maps.google.com/?cid=10371238590330017855',
        fuelPrices: [{ type: 'REGULAR_UNLEADED', price: 3.15, updateTime: hoursAgo(26) }, { type: 'MIDGRADE', price: 3.55, updateTime: hoursAgo(26) }, { type: 'PREMIUM', price: 3.79, updateTime: hoursAgo(26) }, { type: 'DIESEL', price: 3.89, updateTime: hoursAgo(26) }] },
      { id: 'shell-waverley', brand: 'shell', name: 'Shell — Waverley Oaks', lat: 42.383903, lng: -71.209187, distanceMi: 2.20, openNow: true, mapsUrl: 'https://maps.google.com/?cid=11666580242834862824',
        fuelPrices: [{ type: 'REGULAR_UNLEADED', price: 3.02, updateTime: hoursAgo(3) }, { type: 'MIDGRADE', price: 3.42, updateTime: hoursAgo(3) }, { type: 'PREMIUM', price: 3.69, updateTime: hoursAgo(3) }, { type: 'DIESEL', price: 3.79, updateTime: hoursAgo(3) }] },
      { id: 'shell-totten', brand: 'shell', name: 'Shell — Totten Pond', lat: 42.3971683, lng: -71.258545, distanceMi: 2.30, openNow: true, mapsUrl: 'https://maps.google.com/?cid=18165455588548467968',
        fuelPrices: [{ type: 'REGULAR_UNLEADED', price: 3.11, updateTime: hoursAgo(4) }, { type: 'MIDGRADE', price: 3.51, updateTime: hoursAgo(4) }, { type: 'PREMIUM', price: 3.77, updateTime: hoursAgo(4) }, { type: 'DIESEL', price: 3.87, updateTime: hoursAgo(4) }] },
    ];
  }

  window.FuelData = { NOW, HOME, getStationData };
})();
