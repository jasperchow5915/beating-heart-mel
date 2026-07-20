# The Beating Heart of Melbourne

An animated tribute to [**data.pour.paris**](https://data.pour.paris) (the "Beating Heart of Paris"),
rebuilt for Melbourne using official open data.

The original Paris project animated a day of city traffic so that Paris appeared to *pulse* like a
beating heart, its roads carrying the city's lifeblood. This project does the same thing for
Melbourne, but the lifeblood is **people**: it animates a typical day of pedestrian activity across
the CBD, hour by hour, so the city visibly wakes, surges at peak hour, and settles overnight.

![concept](https://img.shields.io/badge/data-City%20of%20Melbourne%20%7C%20CC%20BY%204.0-ff3d6b)

## What you're looking at

- **Glowing dots** are the City of Melbourne's real pedestrian sensors, positioned at their true
  locations. Each dot's size and colour reflect how many people pass that spot at the current hour.
- The clock advances through a **typical 24-hour day** (averaged over the last year of data) and
  loops. Everything gently **throbs** on a cardiac pulse whose rate (BPM) rises and falls with the
  city's activity: a slow ~50 bpm at 4am, racing past 110 bpm at the 5pm peak.
- The bottom trace is the **citywide activity curve** with a moving playhead: the double hump of the
  morning and evening peaks reads like a heartbeat all on its own.
- The **city vitals** monitor (below the clock) reads like a patient monitor: pulse (BPM),
  pedestrians/hr, trams running, trains running, and aircraft aloft, each with a level bar, all
  updating together as the day plays. The heart glyph swells on every beat.

Controls: play/pause, a speed slider, and a time-of-day scrubber. Hover any sensor for its name and
current count.

### City vitals

All the layers report into one readout so you can watch the whole city breathe at a glance. The
counts are the modelled activity for the current time of day (independent of which layers are
toggled on), and the pulse (BPM) is derived from citywide pedestrian volume - slow (~50) overnight,
racing (~110+) at the evening peak.

### Focus view: 188 William Street

Click **Focus on 188 William Street** to spotlight one block. The camera flies in, the rest of the
city dims, and the surrounding street network (within 350 m) is highlighted and labelled straight
from OpenStreetMap. A live panel shows how many pedestrians per hour are passing through the sensors
around that address at the current time of day. The heartbeat keeps beating underneath. The address
is geocoded to the CBD tower (postcode 3000), not the unrelated William Street in the St Albans
suburb.

### Tram & metro networks

Two transit networks are drawn across the map and animated on the *same clock* as the pedestrian
pulse:

- **Trams** (green) - the dense inner-city tram tracks, with frequent vehicles running ~5am-midnight.
- **Metro** (blue) - the metropolitan train lines threading through the CBD, including the
  underground City Loop, with sparser, faster trains and sharper commuter peaks.

For both, the number of vehicles and their brightness follow a **time-of-day service curve**: busy
at the morning and evening peaks, quieter midday, near-empty overnight. Vehicles freeze when playback
is paused and reposition when you scrub. Toggle each layer with the **trams** / **metro** buttons.
Together they're the closest local echo of the Paris project's real-time Metro map.

Both share one generic renderer (`src/transit.ts`), configured per network with its own colour,
speed, spacing, and service curve. Track geometry comes from OpenStreetMap (`railway=tram` and
`railway=rail`); the animation uses a service-level model rather than live vehicle positions (the
[Transport Victoria GTFS Realtime feed](https://opendata.transport.vic.gov.au/dataset/gtfs-realtime)
would be the next step for true real-time vehicles).

### Flights

Aircraft stream in and out of Melbourne's airports (Tullamarine, Essendon, Avalon, Moorabbin) along
arrival and departure corridors, on the *same clock* again: air traffic builds through the morning,
peaks, and thins out overnight. The **airport positions and runway orientations are real** (from
OpenStreetMap), but the individual flights are **procedural** - there is no free "typical day" of
historical flight tracks (see the discussion of live ADS-B options such as OpenSky / airplanes.live,
which are real-time only and non-commercial).

Because the airports sit 11-50 km outside the CBD, flights are **opt-in**: pressing **Show flights**
eases the camera back to a regional view where the sky fills in. Zoom out further to see the full
pattern radiating from Tullamarine. Aircraft are rendered above every other layer (they're in the
sky) and, like everything else, freeze when playback is paused.

## Data sources

| Layer | Dataset | Source | Licence |
| --- | --- | --- | --- |
| Pedestrian pulse | Pedestrian Counting System - sensor locations & hourly counts | [City of Melbourne Open Data](https://melbournetestbed.opendatasoft.com) | CC BY 4.0 |
| Focus streets | Geocoding + street network around an address | [OpenStreetMap](https://www.openstreetmap.org) (Nominatim + Overpass API) | ODbL |
| Tram network | Inner-city tram tracks (`railway=tram`) | [OpenStreetMap](https://www.openstreetmap.org) (Overpass API) | ODbL |
| Metro network | Inner-city train lines incl. City Loop (`railway=rail`) | [OpenStreetMap](https://www.openstreetmap.org) (Overpass API) | ODbL |
| Flights | Airport + runway geometry (`aeroway`); flights simulated | [OpenStreetMap](https://www.openstreetmap.org) (Overpass API) | ODbL |
| Basemap | Dark Matter vector style | [CARTO](https://carto.com/basemaps/) / OpenStreetMap | ODbL (OSM) |

The pedestrian data is fetched from the City of Melbourne OpenDataSoft portal:

- `pedestrian-counting-system-sensor-locations` (134 geo-located sensors)
- `pedestrian-counting-system-monthly-counts-per-hour` (hourly counts since 2009, ~1.6M rows)

### Why pedestrians (and where PTV fits)

Melbourne's pedestrian sensors are the most direct analogue to the Paris "beating heart": a dense,
geo-located, hour-by-hour signal of *human* activity that pulses beautifully over a day.

[Transport Victoria / PTV open data](https://opendata.transport.vic.gov.au) (GTFS schedule + GTFS
Realtime) is the natural **second layer** - animating trains, trams and buses flowing in and out of
the city, much like the Paris Metro real-time map. It's intentionally left as a documented next step
because the GTFS shapes feed is large (~400 MB) and benefits from its own preprocessing pass. The
code is structured so additional animated layers can be added alongside the pedestrian layer.

## How it works

Rather than hammering the API at runtime, a small Node script precomputes a clean **"typical day"**
profile once and writes it to `public/data/heartbeat.json`:

1. Fetch every sensor's location.
2. Find the latest available date and define an averaging window (default: trailing 365 days).
3. For each hour 0-23, ask the API for the **average** pedestrian count per sensor over that window
   (server-side aggregation).
4. Join coordinates + hourly profile, compute citywide totals, and write a single compact JSON file.

The web app loads that file and animates it with MapLibre GL JS (glowing circle layers) plus a
canvas activity trace. No API keys are required.

## Running it

```bash
npm install

# Generate public/data/heartbeat.json from live open data (already checked in once).
# Re-run any time to refresh with the latest counts.
npm run fetch-data

# Generate the focus-view data (geocode 188 William St + surrounding streets).
npm run fetch-focus

# Generate the inner-city tram + metro networks.
npm run fetch-trams
npm run fetch-metro

# Generate airport geometry + flight corridors.
npm run fetch-flights

# Start the dev server
npm run dev

# Production build + local preview
npm run build
npm run preview
```

Optional: average over a different window when fetching data:

```bash
BHOM_WINDOW_DAYS=90 npm run fetch-data
```

## Project structure

```
beating-heart-of-melbourne/
├── index.html               # App shell + controls
├── scripts/
│   ├── fetch-data.mjs        # Open-data fetch + typical-day aggregation
│   ├── fetch-focus.mjs       # Geocode an address + fetch surrounding streets (OSM)
│   ├── fetch-trams.mjs       # Fetch + chain the inner-city tram network (OSM)
│   ├── fetch-metro.mjs       # Fetch + chain the inner-city metro network (OSM)
│   └── fetch-flights.mjs     # Fetch airports/runways (OSM) + derive flight corridors
├── public/data/
│   ├── heartbeat.json        # Generated: sensors + hourly profile + city totals
│   ├── focus-william-st.json # Generated: focus centre + local street network
│   ├── trams.json            # Generated: chained tram paths
│   ├── metro.json            # Generated: chained metro/rail paths
│   └── flights.json          # Generated: airports + flight corridors
└── src/
    ├── main.ts               # Orchestration, animation loop, UI controls
    ├── map.ts                # MapLibre dark map + pulsing sensor layers
    ├── heartbeat.ts          # Canvas activity trace with playhead
    ├── focus.ts              # Focus view: spotlight + highlighted streets
    ├── transit.ts            # Generic transit layer (trams + metro) synced to the clock
    ├── flights.ts            # Procedural flights over real airports, synced to the clock
    ├── vitals.ts             # City vitals monitor (pulse, pedestrians, trams, trains, flights)
    ├── data.ts               # Types + data loader
    ├── util.ts               # Interpolation, colour ramp, cardiac pulse, haversine
    └── style.css             # Dark, glowing UI theme
```

## Attribution

- Pedestrian data © City of Melbourne, licensed under **CC BY 4.0**.
- Focus-view geocoding and street network © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (**ODbL**), via Nominatim and the Overpass API.
- Basemap © [CARTO](https://carto.com/), map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
- Concept inspired by [data.pour.paris](https://data.pour.paris) and the
  ["Beating Heart of Paris"](https://googlemapsmania.blogspot.com/2019/09/the-beating-heart-of-paris.html) writeup.

## Ideas for extending

- Add the **PTV / Transport Victoria** GTFS layer: interpolate vehicle positions along route shapes
  to animate trains/trams/buses over the same 24-hour clock.
- Add a **weekday vs weekend** toggle (the profile aggregation already supports date filtering).
- Add other City of Melbourne sensor feeds (e.g. traffic, microclimate) as selectable "vital signs".
