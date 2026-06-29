# Data Shape Contract

This is the **exact** shape `getStationData()` returns today (sample data),
pulled directly from `index.html`. Any live implementation — the serverless
proxy, the `fetch('/api/prices')` replacement — must return data matching
this shape, or the rest of the app (rendering, sorting, freshness badges,
the "cheapest" crown, off-screen indicators) breaks silently or loudly.

## Top-level: array of station objects

```js
[
  {
    id: 'mobil-moody',              // string, unique, used as a DOM/marker key — stable, don't reuse across stations
    brand: 'mobil',                 // a brand-registry key (see notes) — used for CSS theming, filtering, brand counts
    name: 'Mobil — Moody St',       // display name shown in the popup header
    lat: 42.361529,                 // number, station latitude
    lng: -71.2393409,               // number, station longitude
    distanceMi: 0.45,               // number, straight-line miles from home — currently hand-computed, not derived
    openNow: true,                  // boolean, shown as an "Open"/"Closed" pill in the popup
    mapsUrl: 'https://maps.google.com/?cid=...',  // used for the "Navigate" link/button
    fuelPrices: [                   // array — CAN BE EMPTY (see shell-totten below)
      { type: 'REGULAR_UNLEADED', price: 3.05, updateTime: '2026-06-28T03:00:00.000Z' },
      { type: 'MIDGRADE',         price: 3.45, updateTime: '2026-06-28T03:00:00.000Z' },
      { type: 'PREMIUM',          price: 3.69, updateTime: '2026-06-28T03:00:00.000Z' },
      { type: 'DIESEL',           price: 3.79, updateTime: '2026-06-28T03:00:00.000Z' },
    ],
  },
  // ...6 more stations
]
```

## Field-by-field notes

- **`brand`** — a key from the **brand registry** (`BRANDS` in `app.js`), or the
  literal `'other'` for independents/unbranded. The registry is the curated set of
  "major" brands (currently `shell`, `mobil`, `bp`, `chevron`, `phillips66`), each
  with a label, accent color, and tag aliases. For the hand-written home stations
  this is set directly (`'shell'` / `'mobil'`); for live search results it's
  derived by `classifyBrand(tags)` from the OSM `brand`/`operator`/`name` tags.
  The toolbar filter, brand counts, and pin/chip colors all key off this value, so
  a live (Google) implementation must map its brands onto registry keys the same
  way — return a registry key when it's one of ours, else `'other'`. Full rationale
  in `DECISIONS.md` ("Brand registry + multi-select filter").
- **`id`** — must be stable across refreshes (used as a `markerById[id]` key
  for popups, off-screen indicator clicks, fade animations). If a live API
  call returns stations in a different order each time, don't regenerate
  IDs from array index — derive from something stable (e.g. the Google
  Place ID itself).
- **`fuelPrices`** — this is intentionally shaped to mirror Google Places
  API (New)'s `place.fuelOptions.fuelPrices[]` response almost exactly:
  `{ type, price, updateTime }`. This was a deliberate design choice from
  early in the build so the eventual live-data swap requires minimal
  reshaping. **Known Google fuel `type` enum values used here:**
  `REGULAR_UNLEADED`, `MIDGRADE`, `PREMIUM`, `DIESEL`. The UI currently only
  *renders* the first three (Diesel was removed from the toolbar and from
  `GORD`, the active-grade list, by request) — but leaving `DIESEL` entries
  in the data is harmless and was kept on purpose in case it's restored.
- **`fuelPrices` can be an empty array.** `shell-totten` (Shell — Totten
  Pond) has `fuelPrices: []` on purpose — it's the deliberately-included
  "this station has no reported fuel data" case, exercised to make sure the
  UI shows an honest "no data" state (a "—" instead of crashing or showing
  a stale/wrong number). **Do not "fix" this by inventing a price for it in
  sample data** — it's there to keep that code path honest. A live
  implementation will hit this same situation naturally whenever Google
  doesn't have `fuelOptions` for a given station.
- **`updateTime`** — ISO 8601 string. The UI computes an "age" from this
  (`Xm ago` / `Xh ago` / `Xd ago`) per fuel type and color-codes it: fresh
  (<12h, green), aging (12–48h, amber), stale (>48h, red), no-data (gray).
  This is the actual "how do we know the price is accurate" mechanism for
  the whole app — a live implementation must pass through Google's real
  `updateTime`, not substitute the time of the API call itself, or the
  freshness indicator becomes meaningless.
- **`distanceMi`** — currently hand-entered, not computed. A live version
  could compute this from `lat`/`lng` vs. the `HOME` constant
  (`{lat: 42.3667, lng: -71.2452}`) using the haversine formula instead of
  hardcoding it, since it'll never change per station.
- **`mapsUrl`** — currently real `maps.google.com/?cid=` links for the
  actual 7 stations (pulled from the original Google Places lookup earlier
  in the project), not placeholders.

## What's missing for a live implementation

The sample data has everything the *frontend* needs, but **not the Google
Place ID for each station** — only a `cid` link, which isn't the same thing
as a Place ID usable with the Places API's Place Details endpoint. Before
building the serverless proxy, resolve and store each station's actual
Place ID (e.g. via a one-time Place Search/Text Search call, or by
extracting it from the Place Details response when you first set this up).

## Constants the rest of the app depends on

```js
const HOME = { lat: 42.3667, lng: -71.2452 };  // 60 Hope Ave, Waltham, MA 02453
```

This is used for the home pin, the "fit all stations" bounds calculation,
and the locate/recenter button's centering logic. Don't change without
updating those.
