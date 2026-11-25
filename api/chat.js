// ============================================================
// Vercel serverless function — map chat assistant (OpenAI Responses API).
// ------------------------------------------------------------
//   POST /api/chat
//   body: { passcode, messages: [{role:'user'|'assistant', content}], map_context }
//   → 200 { reply, actions: [...], usage }
//   → 401 { error: 'passcode' }   wrong / missing passcode
//
// Env vars (Vercel → Project → Settings → Environment Variables):
//   OPENAI_API_KEY           required — keep it server-side, never in the browser
//   CHAT_PASSCODE            required — the chat refuses to run without one, so a
//                            public URL can't run up your OpenAI bill
//   OPENAI_MODEL             optional, default 'gpt-6-luna'
//   OPENAI_REASONING_EFFORT  optional, default 'low' (none|low|medium|high|…)
//
// HOW IT WORKS: the model gets two kinds of tools.
//   • DATA tools (find_place, find_stations) run HERE, by calling this site's own
//     /api/geocode and /api/stations — so they share those endpoints' edge cache
//     and Google cost guardrails instead of duplicating them.
//   • MAP tools (show_search_results, set_fuel_grade, set_brand_filter,
//     focus_station) are NOT executed here: they're recorded as "actions" and sent
//     back to the browser, which drives the map with its existing functions.
// The whole tool loop for one question runs inside this one request.
//
// COST GUARDS: passcode, ≤6 model rounds and ≤6 data lookups per question,
// capped output tokens, trimmed history. Also set a monthly budget in the OpenAI
// dashboard.
// ============================================================

const MAX_ROUNDS = 6;          // model calls per question
const MAX_LOOKUPS = 6;         // find_place + find_stations calls per question
const MAX_HISTORY = 12;        // most recent chat messages sent to the model
const MAX_MSG_CHARS = 2000;
const MI_TO_M = 1609.34;

const BRAND_KEYS = ['shell', 'mobil', 'bp', 'chevron', 'phillips66', 'other'];
const GRADES = ['REGULAR_UNLEADED', 'MIDGRADE', 'PREMIUM'];

const INSTRUCTIONS = `You are the map assistant inside "Hope Ave Fuel", a web app that shows live gas prices on a map. The user chats with you in a panel beside the map. You answer in text AND drive the map with tools.

Data rules:
- Only state prices, open/closed status and update times that come from tool results or from the MAP CONTEXT message. Never guess or invent a price. If a station has no price for a grade, say so.
- Prices come from Google and can be stale; mention the age when it is over 24 hours.
- Fuel grades: REGULAR_UNLEADED (shown as "Reg"), MIDGRADE ("Mid"), PREMIUM ("Prem"). Diesel is not shown in the app.
- Brand filter keys: shell = Shell; mobil = Exxon/Mobil (also Esso); bp = BP/Amoco/ARCO; chevron = Chevron/Texaco; phillips66 = Phillips 66; other = every other brand and independents (e.g. Sunoco, Citgo, Gulf, Speedway, Costco).

How to act:
- For a place the user names: find_place, then find_stations, then show_search_results so the map moves there. If one station answers the question (e.g. the cheapest), pass its id as focus_station_id.
- To compare places, you may search several, then show the most relevant one.
- For questions about what is already on the map, use the MAP CONTEXT; no new search is needed. Use focus_station to point at a station from it.
- Switch the grade with set_fuel_grade when the user asks about a specific grade, so the map's pins match your answer.
- Use set_brand_filter when the user wants to see only certain brands, or when your answer is about a brand the filter currently hides (e.g. an "other" station).
- Radius: default 2.5 miles, maximum 5.

Reply style: 1-3 short sentences of plain text, no markdown, no tables, prices like $3.49. If a request is unrelated to gas stations, prices or the map, say briefly what you can help with.`;

const TOOLS = [
  fn('find_place', 'Look up a place (address, landmark, city, ZIP) and get its coordinates and a short label.', {
    query: { type: 'string', description: 'What to look up, e.g. "Fenway Park, Boston" or "02139".' },
  }),
  fn('find_stations', 'Find gas stations around a point with their current prices. Returns a search_id to pass to show_search_results.', {
    lat: { type: 'number' },
    lng: { type: 'number' },
    label: { type: 'string', description: 'Short name of the place, shown as the map title.' },
    radius_miles: { type: 'number', description: 'Search radius, 0.5 to 5. Use 2.5 unless the user asks otherwise.' },
  }),
  fn('show_search_results', 'Show the stations from one find_stations call on the map: the map moves there and frames them.', {
    search_id: { type: 'string' },
    focus_station_id: { type: ['string', 'null'], description: 'Optional station id from that search to zoom to and open its card.' },
  }),
  fn('set_fuel_grade', 'Switch which fuel grade the map pins show.', {
    grade: { type: 'string', enum: GRADES },
  }),
  fn('set_brand_filter', 'Choose which brands are visible on the map.', {
    brands: { type: 'array', items: { type: 'string', enum: BRAND_KEYS } },
  }),
  fn('focus_station', 'Zoom to a station that is on the map (in the MAP CONTEXT or the last shown search) and open its card.', {
    station_id: { type: 'string' },
  }),
];

function fn(name, description, properties) {
  return {
    type: 'function', name, description, strict: true,
    parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const key = process.env.OPENAI_API_KEY;
  const pass = process.env.CHAT_PASSCODE;
  if (!key || !pass) return res.status(500).json({ error: 'chat not configured (OPENAI_API_KEY / CHAT_PASSCODE missing)' });

  const body = req.body || {};
  if (String(body.passcode || '') !== pass) return res.status(401).json({ error: 'passcode' });

  const history = (Array.isArray(body.messages) ? body.messages : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_HISTORY)
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_MSG_CHARS) }));
  if (!history.length || history[history.length - 1].role !== 'user') return res.status(400).json({ error: 'last message must be from the user' });

  // Map context goes in as a developer message right before the newest question.
  const ctx = { role: 'developer', content: 'MAP CONTEXT (what the user sees right now):\n' + JSON.stringify(body.map_context || {}).slice(0, 12000) };
  const input = [...history.slice(0, -1), ctx, history[history.length - 1]];

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const base = `${proto}://${req.headers.host}`;
  const searches = {};   // search_id → { origin, radiusMi, raw stations } for show_search_results
  const actions = [];
  const usage = { input_tokens: 0, output_tokens: 0, rounds: 0, lookups: 0 };

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const r = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || 'gpt-6-luna',
          instructions: INSTRUCTIONS,
          input,
          tools: TOOLS,
          reasoning: { effort: process.env.OPENAI_REASONING_EFFORT || 'low' },
          max_output_tokens: 3000,
        }),
      });
      const j = await r.json();
      if (!r.ok) return res.status(502).json({ error: 'openai ' + r.status, message: (j.error && j.error.message) || null });

      usage.rounds++;
      if (j.usage) { usage.input_tokens += j.usage.input_tokens || 0; usage.output_tokens += j.usage.output_tokens || 0; }

      const out = Array.isArray(j.output) ? j.output : [];
      const calls = out.filter(o => o.type === 'function_call');
      if (!calls.length) {
        const reply = out.filter(o => o.type === 'message')
          .flatMap(o => o.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('').trim();
        return res.status(200).json({
          reply: reply || (j.status === 'incomplete' ? 'Sorry — that answer ran too long. Try a narrower question.' : 'Done.'),
          actions, usage,
        });
      }

      input.push(...out);   // documented pattern: send the model's output items (incl. reasoning) back
      for (const c of calls) {
        let args;
        try { args = JSON.parse(c.arguments || '{}'); } catch (e) { args = null; }
        const result = args ? await runTool(c.name, args, { base, searches, actions, usage }) : { error: 'arguments were not valid JSON' };
        input.push({ type: 'function_call_output', call_id: c.call_id, output: JSON.stringify(result) });
      }
    }
    return res.status(200).json({ reply: 'Sorry — I couldn’t finish that in time. Try asking more simply.', actions, usage });
  } catch (e) {
    return res.status(502).json({ error: 'chat failed', message: String(e && e.message || e) });
  }
}

async function runTool(name, a, { base, searches, actions, usage }) {
  if (name === 'find_place' || name === 'find_stations') {
    if (usage.lookups >= MAX_LOOKUPS) return { error: 'lookup limit reached for this question — answer with what you have' };
    usage.lookups++;
  }
  switch (name) {
    case 'find_place': {
      const r = await fetch(`${base}/api/geocode?q=${encodeURIComponent(a.query)}`);
      if (!r.ok) return { error: 'geocoding failed (' + r.status + ')' };
      const p = await r.json();
      return p ? { found: true, lat: p.lat, lng: p.lng, label: p.label, full: p.full } : { found: false };
    }
    case 'find_stations': {
      const radiusMi = Math.min(5, Math.max(0.5, Number(a.radius_miles) || 2.5));
      const r = await fetch(`${base}/api/stations?lat=${a.lat}&lng=${a.lng}&radius=${Math.round(radiusMi * MI_TO_M)}`);
      if (!r.ok) return { error: 'station search failed (' + r.status + ')' };
      const raw = await r.json();
      const id = 's' + (Object.keys(searches).length + 1);
      searches[id] = { origin: { lat: a.lat, lng: a.lng, label: a.label || 'Search area' }, radiusMi, raw };
      const now = Date.now();
      const stations = raw.map(s => ({
        id: s.id, name: s.name, distance_mi: +distMi(a.lat, a.lng, s.lat, s.lng).toFixed(2), open_now: s.openNow,
        prices: Object.fromEntries((s.fuelPrices || []).filter(p => GRADES.includes(p.type))
          .map(p => [p.type, { price: p.price, hours_old: Math.round((now - Date.parse(p.updateTime)) / 36e5) }])),
      })).sort((x, y) => x.distance_mi - y.distance_mi);
      return { search_id: id, center: a.label, radius_miles: radiusMi, count: stations.length, stations };
    }
    case 'show_search_results': {
      const s = searches[a.search_id];
      if (!s) return { error: 'unknown search_id — call find_stations first' };
      actions.push({ type: 'show_search_results', origin: s.origin, radius_miles: s.radiusMi, stations: s.raw, focus_station_id: a.focus_station_id || null });
      return { ok: true };
    }
    case 'set_fuel_grade':
      if (!GRADES.includes(a.grade)) return { error: 'unknown grade' };
      actions.push({ type: 'set_fuel_grade', grade: a.grade });
      return { ok: true };
    case 'set_brand_filter': {
      const brands = (a.brands || []).filter(b => BRAND_KEYS.includes(b));
      actions.push({ type: 'set_brand_filter', brands });
      return { ok: true };
    }
    case 'focus_station':
      actions.push({ type: 'focus_station', station_id: String(a.station_id) });
      return { ok: true };
    default:
      return { error: 'unknown tool ' + name };
  }
}

function distMi(aLat, aLng, bLat, bLng) {
  const R = 3958.8, toRad = d => d * Math.PI / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
