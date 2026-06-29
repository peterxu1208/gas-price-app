// ============================================================
// Vercel serverless function — Google Geocoding proxy.
// ------------------------------------------------------------
// Keeps GOOGLE_SERVER_KEY server-side (never shipped to the browser).
//   GET /api/geocode?q=<place text>
//   → { lat, lng, label, full }   on success
//   → null                        when nothing matches
// Mirrors the shape services.js geocode() already expects, so the
// front end needs no changes.
// ============================================================

export default async function handler(req, res) {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'missing q' });

  const key = process.env.GOOGLE_SERVER_KEY;
  if (!key) return res.status(500).json({ error: 'GOOGLE_SERVER_KEY not configured' });

  try {
    const url = 'https://maps.googleapis.com/maps/api/geocode/json?address='
      + encodeURIComponent(q) + '&key=' + key;
    const r = await fetch(url);
    const j = await r.json();
    if (j.status !== 'OK' || !j.results || !j.results.length) {
      return res.status(200).json(null);   // honest "no match" — front end shows a toast
    }

    const g = j.results[0];
    const loc = g.geometry.location;
    // A place rarely changes coordinates — cache a day at the edge.
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json({
      lat: loc.lat,
      lng: loc.lng,
      label: shortLabel(g),
      full: g.formatted_address,
    });
  } catch (e) {
    return res.status(502).json({ error: 'geocode failed' });
  }
}

// Build a compact "Street, City" style label from address components,
// falling back to the first part of the full formatted address.
function shortLabel(g) {
  const comps = g.address_components || [];
  const pick = (type) => {
    const c = comps.find(c => c.types.includes(type));
    return c ? c.long_name : null;
  };
  const primary = pick('route') || pick('neighborhood') || pick('sublocality')
    || pick('locality') || pick('postal_code');
  const city = pick('locality') || pick('administrative_area_level_2') || pick('administrative_area_level_1');
  if (primary && city && primary !== city) return `${primary}, ${city}`;
  return primary || city || (g.formatted_address || '').split(',').slice(0, 2).join(',').trim();
}
