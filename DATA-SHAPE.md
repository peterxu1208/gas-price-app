# Data Shape Contract

> Last synced to the code: **2026-11-24**. Previous version (sample-data era) in
> `docs-archive/DATA-SHAPE-2026-07.md`.

Data passes through three shapes on its way to the screen:

```
Google Places API (New)  →  api/stations.js  →  services.js toStation()  →  app.js
                           "proxy station"      "app station"
```

Anything that replaces a layer must keep the shape the next layer expects, or the
rendering, sorting, freshness badges, cheapest crown and edge chips break.

## 1. Proxy station — `GET /api/stations?lat=&lng=&radius=`

Returns an array (up to 20) of:

```js
{
  id: 'ChIJE6g2VPCC44kR0do-eln819o',   // Google Place ID
  name: 'Shell',                        // Google displayName.text ('Gas station' if missing)
  lat: 42.3500341,
  lng: -71.2251551,
  openNow: true,                        // true | false | null (null = Google didn't say)
  fuelPrices: [                         // may be EMPTY — Google has no fuelOptions for many stations
    { type: 'REGULAR_UNLEADED', price: 3.9, updateTime: '2026-11-24T13:19:53Z' },
    { type: 'PREMIUM',          price: 5.5, updateTime: '2026-11-24T06:13:44Z' },
    // MIDGRADE, DIESEL, … in whatever order Google returns them
  ],
}
```

- `price` is converted from Google's money object: `units + nanos / 1e9`.
- `radius` is in meters, defaults to 4000, capped at 50000.
- Errors: 400 missing lat/lng · 500 `GOOGLE_SERVER_KEY not configured` · 502
  `places error` (with Google's error detail) or `stations failed`.

## 2. App station — what `FuelServices.findStationsNear()` returns

`toStation()` in `services.js` turns each proxy station into this; the array comes
back sorted by `distanceMi`, nearest first.

```js
{
  id: 'ChIJE6g2VPCC44kR0do-eln819o',   // Place ID; fallback `g-<lat>,<lng>` if missing
  brand: 'shell',                       // registry key or 'other' (see below)
  name: 'Shell',                        // shown in the card header and edge-chip tooltip
  lat: 42.3500341,
  lng: -71.2251551,
  distanceMi: 1.62,                     // haversine miles from the CURRENT ORIGIN
  openNow: true,                        // true | false | null
  mapsUrl: 'https://www.google.com/maps/search/?api=1&query=<lat>,<lng>&query_place_id=<id>',
  fuelPrices: [ { type, price, updateTime }, … ],   // passed through unchanged; may be []
}
```

### Field notes

- **`id`** — must be stable across refreshes: it keys `markerById`, edge chips, and
  the crossfade. Never derive it from the array index.
- **`brand`** — `classifyBrand({ name })` from `app.js`, injected via
  `FuelServices.configure()`. Returns a `BRANDS` key (`shell`, `mobil`, `bp`,
  `chevron`, `phillips66`) when the name matches an alias on a word boundary, else
  `'other'`. Only the Google display name is checked. Filter, counts and pin colors
  all key off this value.
- **`distanceMi`** — measured from whatever origin the stations were fetched around
  (home, searched place, or device location), not from home specifically.
- **`openNow`** — `null` hides the Open/Closed text in the card.
- **`fuelPrices[].type`** — Google's enum. The UI renders `REGULAR_UNLEADED`,
  `MIDGRADE`, `PREMIUM` (`GORD` in `app.js`). `DIESEL` and any other types are kept
  in the data but not shown. Note: the toolbar freshness stamp looks at **all** types,
  diesel included.
- **`fuelPrices[].updateTime`** — Google's real ISO timestamp for when that price
  was reported. This drives every freshness indicator (green < 12 h, amber 12–48 h,
  red > 48 h, grey missing). Never substitute the time of the API call, or the
  freshness indicator becomes meaningless.
- **Empty `fuelPrices`** is normal. The pin shows a dashed **N/A** tag, the card
  shows N/A per grade, and such stations are skipped when picking the cheapest.

## 3. Geocode result — `GET /api/geocode?q=` or `?latlng=lat,lng`

```js
{ lat: 42.3764358, lng: -71.2357501, label: 'Waltham', full: 'Waltham, MA, USA' }
```

- `label` — short "Street, City" style label (falls back to city, ZIP, or the first
  two parts of the formatted address). Shown as the toolbar location name.
- `full` — Google's formatted address; shown on hover and stored for the home.
- Returns `null` (HTTP 200) when nothing matches. Other Google statuses → 502 with
  `{ error: 'geocode <STATUS>', message }`.

## 3b. Map chat — `POST /api/chat`

Request:
```js
{ passcode: '…',
  messages: [{ role: 'user' | 'assistant', content: 'text' }, …],   // newest last, must end with 'user'
  map_context: { place, full_address, center:{lat,lng}, radius_miles, grade_shown,
                 brands_shown:[…], stations:[{ id, name, brand, distance_mi, open_now,
                 shown, prices:{GRADE: price}, newest_price_hours_old }] } }
```

Response 200:
```js
{ reply: 'The cheapest premium near Fenway is Shell at $4.75.',
  actions: [   // applied by app.js in this order: show → brands → grade → focus
    { type: 'show_search_results', origin:{lat,lng,label}, radius_miles, stations:[<proxy station>…], focus_station_id: id|null },
    { type: 'set_brand_filter', brands: ['shell','mobil', …, 'other'] },
    { type: 'set_fuel_grade', grade: 'REGULAR_UNLEADED' | 'MIDGRADE' | 'PREMIUM' },
    { type: 'focus_station', station_id: id },
  ],
  usage: { input_tokens, output_tokens, rounds, lookups } }
```
Errors: 401 `{error:'passcode'}` · 400 bad messages · 405 not POST · 500 env vars
missing · 502 OpenAI/lookup failure (`{error, message}`).

`show_search_results.stations` are **proxy stations** (shape 1); the browser converts
them with `FuelServices.fromRaw(raw, originLat, originLng)` (= `toStation()`).

## 4. Saved home — `localStorage['fuelHome']`

```js
{ lat, lng, label, full }   // same as a geocode result
```

## Constants the app depends on (`data.js`)

```js
const HOME = { lat: 42.3667, lng: -71.2452 };  // 60 Hope Ave, Waltham — the fallback seed
const NOW  = Date.now();                        // page-load time; all "Xh ago" ages use it
```

`HOME` is used only when no home is saved and device location is unavailable (and
by the unused `getHomeStations()`). `data.js` also still contains
`getStationData()`, the original 7-station sample fixture; it is not used by the
app.
