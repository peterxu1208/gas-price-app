# Hope Ave Fuel

Personal gas-price map: live prices for gas stations near you, your saved home, or
any place you search. Prices and search come from Google; the map itself is
Leaflet with CARTO Voyager street tiles (Esri as backup — see "Map tiles" below).

**Live app:** https://gas-price-app-nu.vercel.app

## Start here

1. **Read `DECISIONS.md`** — how the app works, the decisions behind it, and the
   fragile spots (hover timing, pointer-events, edge chips) that are easy to break.
2. **Read `DATA-SHAPE.md`** before touching anything data-related — the exact shapes
   passed between Google, the proxy, `services.js` and `app.js`.

## Files

No build step: `index.html` loads Leaflet (CDN), then `data.js`, `services.js`,
`app.js` with plain `<script>` tags.

| File | What it is |
|---|---|
| `index.html` | Markup: map, search bar, toolbar card, home chip + gear, "near me" button, set-home modal |
| `styles.css` | All styling. Font sizes are tokens in `:root` (`--fs-lg/base/sm/xs` = 18/16/14/12); mobile layout at ≤640 px |
| `data.js` | `HOME` (Waltham fallback point) and `NOW` (page-load time). Also the old 7-station sample data, now unused |
| `services.js` | The only file that makes network calls: `geocode`, `reverseGeocode`, `findStationsNear`, `getCurrentPosition`, `chat` |
| `app.js` | Everything else: map + tiles, pins, cards, edge chips, filters, radius, search, home, map chat panel, startup |
| `api/stations.js` | Vercel function → Google Places API (New) nearby gas stations with `fuelOptions` prices |
| `api/geocode.js` | Vercel function → Google Geocoding API (search and reverse) |
| `api/chat.js` | Vercel function → OpenAI (`gpt-6-luna`) for the map chat; runs the tool loop, returns a reply + map actions |
| `_selfcheck.js` | Dev-only UI checker, not loaded by the app (see `DECISIONS.md`) |
| `Start Hope Ave Fuel.bat` | Local static server on port 8753 — UI only, no live data |
| `docs-archive/` | Previous versions of these notes (July 2026) |

## Using it

- **Search bar** — type a place and press Enter; the map moves there and shows
  stations within the radius. ✕ clears the text only.
- **Grade** — Reg / Mid / Prem (default Premium).
- **Brands** — All, Shell, Exxon/Mobil, BP/Amoco, Chevron/Texaco, Phillips 66,
  Other. Majors present in the area start checked; Other (independents) starts off.
- **Radius** — 0.5–5 mi, default 2.5; re-fetches when you let go. Resets on reload.
- **Home chip + gear** — the gear opens "Set home address"; once saved (on this
  device only), the Home chip jumps back there.
- **Bottom-right button** — stations near your current location.
- **Pins** — hover (desktop) or tap (phone) for all grades, freshness, Open/Closed,
  and NAVIGATE. The cheapest gets a ◆ CHEAPEST crown. Stations off-screen or
  hidden under the toolbar show arrow chips at the edge.

- **Chat button** (green, above the bottom-right button) — "Ask the map": ask in
  plain English ("cheapest premium near Fenway Park?", "show only Shell"). It
  answers in text and moves the map, sets grade/brand filters and opens station
  cards. Asks for the chat passcode once per device. On phones, the sheet shrinks to
  the latest reply after the map moves; tap it to expand.

On first open with no saved home, the app asks for your location; if you decline,
it opens on 60 Hope Ave, Waltham.

## Running and deploying

- **Deployed (normal use):** Vercel project serving this folder, with the Google
  key in the `GOOGLE_SERVER_KEY` environment variable. After changing an env var,
  redeploy for it to take effect.
- **Local, UI only:** double-click `Start Hope Ave Fuel.bat`. The map loads, but
  there's no `/api`, so it shows "Couldn't load live prices".
- **Local with live data:** `vercel dev` with `GOOGLE_SERVER_KEY` set (needs Node and
  the Vercel CLI — not installed on this machine yet).

## Map tiles (CARTO key)

Since September 2026 CARTO requires a key; without a valid one every tile shows an
"API KEY REQUIRED" watermark. The app's key is in `const CARTO_KEY` in `app.js`
(added 2026-11-24; free personal tier, 5M tiles/month, managed at
dashboard.basemaps.carto.com). If the key stops working, the app detects the
watermark and switches to Esri tiles automatically. To replace the key, request a new
one at https://carto.com/basemaps/apikey, paste it into `CARTO_KEY`, and redeploy.
The key is visible in the browser by design, so keep it restricted to the site's
domain in CARTO's dashboard.

## Google setup (what the key needs)

In Google Cloud Console, for the project that owns the key:
- **Places API (New)** and **Geocoding API** enabled.
- An active billing account (free usage caps apply; set a budget alert).
- The key is used **server-side** only, so restrict it by *API* (those two), not by
  website/HTTP referrer — a referrer restriction blocks server calls.

Quick health check: open
`https://gas-price-app-nu.vercel.app/api/geocode?q=Waltham` — a JSON place means
Google is connected; an `error` like `geocode REQUEST_DENIED` includes Google's
reason.

## Map chat setup (OpenAI)

The chat calls OpenAI from `api/chat.js`; the key never reaches the browser. In
Vercel → Project → Settings → Environment Variables (Production), set:

| Variable | Required | What |
|---|---|---|
| `OPENAI_API_KEY` | yes | From platform.openai.com → API keys |
| `CHAT_PASSCODE` | yes | Any passcode you choose; the chat refuses to run without one so the public URL can't spend your credit |
| `OPENAI_MODEL` | no | Default `gpt-6-luna` |
| `OPENAI_REASONING_EFFORT` | no | Default `low` (`none`/`low`/`medium`/`high`) |

Env vars only apply to deployments made **after** they're set — add them, then
commit/redeploy. In the OpenAI dashboard, set a monthly **budget limit**. Cost at
`gpt-6-luna` prices ($0.10 / $0.50 per 1M tokens): a typical question uses ~8K input
tokens → about $0.001. OpenAI keeps request data for 30 days by default (`store`).
If the chat says "passcode didn't work", the device's saved passcode is cleared and
it asks again.
