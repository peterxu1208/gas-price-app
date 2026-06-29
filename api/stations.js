// ============================================================
// Vercel serverless function — Google Places API (New) searchNearby proxy.
// ------------------------------------------------------------
// Keeps GOOGLE_SERVER_KEY server-side (never shipped to the browser).
//   GET /api/stations?lat=&lng=&radius=
//   → [{ id, name, lat, lng, openNow, fuelPrices:[{type,price,updateTime}] }]
// Brand classification and distance are added client-side in services.js
// (so the brand registry + colors stay in the UI layer), which is why this
// returns the raw-ish station shape rather than the full app shape.
//
// COST: fuelOptions is Google's priciest Places tier. The Cache-Control below
// makes the edge serve a cached response for hours — Google refreshes fuel
// prices ~daily, so this is the main lever keeping the bill near zero. Do not
// remove it.
// ============================================================

export default async function handler(req, res) {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const radius = Math.min(parseFloat(req.query.radius) || 4000, 50000);   // Places caps circle radius at 50km
  if (Number.isNaN(lat) || Number.isNaN(lng)) return res.status(400).json({ error: 'missing lat/lng' });

  const key = process.env.GOOGLE_SERVER_KEY;
  if (!key) return res.status(500).json({ error: 'GOOGLE_SERVER_KEY not configured' });

  try {
    const r = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        // Only the fields we use — a tighter mask is cheaper and faster.
        'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.fuelOptions,places.currentOpeningHours',
      },
      body: JSON.stringify({
        includedTypes: ['gas_station'],
        maxResultCount: 20,
        locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius } },
      }),
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'places error', detail: j.error || null });

    const stations = (j.places || []).map(p => ({
      id: p.id,
      name: (p.displayName && p.displayName.text) || 'Gas station',
      lat: p.location.latitude,
      lng: p.location.longitude,
      openNow: p.currentOpeningHours ? (p.currentOpeningHours.openNow ?? null) : null,
      fuelPrices: ((p.fuelOptions && p.fuelOptions.fuelPrices) || []).map(fp => ({
        type: fp.type,                                                  // e.g. REGULAR_UNLEADED / MIDGRADE / PREMIUM / DIESEL
        price: Number(fp.price.units || 0) + (fp.price.nanos || 0) / 1e9,
        updateTime: fp.updateTime,
      })),
    }));

    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400');   // 24h fresh, +24h stale-OK — matches Google's ~daily refresh; caps Google hits at ~1/day/location
    return res.status(200).json(stations);
  } catch (e) {
    return res.status(502).json({ error: 'stations failed' });
  }
}
