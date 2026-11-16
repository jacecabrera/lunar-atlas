# Lunar Atlas (Lunar Landing Site Navigator)

An interactive web app for choosing where and when to land on the Moon. You enter a landing time, a surface mission length and an Earth launch location. The app then shows how sunlight and Earth visibility change over your mission, checks whether a solar-plus-battery lander can survive, and recommends up to three landing sites with the reasons, formulas and data sources behind each one.

Built for the NASA Space Apps Challenge "Lunar Landing Site Navigator".

## The problem

A solar-powered lander lives or dies by light. A typical lunar night lasts about two Earth weeks, and near the poles the Sun skims the horizon, so a ridge a few kilometres away can decide whether a site is lit at all. Whether a site works depends on three things at once: when you land, how long you stay, and the terrain around the site. Moon Planner puts those into one place so a user can compare candidate sites for their own mission instead of reasoning about each factor separately.

## What it does

1. **Takes three inputs.** Landing time (UTC), mission length on the surface (Earth days) and an Earth launch location (latitude and longitude). Nothing is pre-filled or defaulted to "now".
2. **Shows a true-scale, time-driven Earth, Moon and Sun scene.** Positions, rotation and lighting come from an ephemeris, so what you see is the real Sun and Earth geometry at the selected instant. A clock bar lets you play, pause, change speed and jump through time.
3. **Evaluates candidate sites over exactly your mission window** (landing time to landing time plus mission length). Each site is checked on four conditions:
   - **Terrain:** a footprint slope and obstacle screen.
   - **Power:** an energy simulation of the lander's panels and battery.
   - **Communication:** the Earth must be above the horizon at times when the lander has power.
   - **Data completeness:** whether there is enough data to decide at all.
4. **Recommends up to 3 sites**, ranked by a score built from sunlight, Earth visibility and terrain. If no site qualifies, the app says so and explains why instead of padding the list.
5. **Lets you test your own sites.** Click the Moon or type coordinates, press Check site, and confirm up to 9 custom sites that are evaluated by the same rules.
6. **Estimates transit and draws an illustrative route** from your launch location to each site.
7. **Opens a details page** for the valid sites: sunlight and darkness statistics, charts, the formulas used, the settings, the data sources and the next sunset and Earthset. Every number can be traced to a source or a stated assumption.

## How it works

### Pipeline

```
 UTC time ──► time scales (UTC, TAI, TT) ──► ephemeris (Moon, Sun, Earth orientation)
                                                   │
                       Moon-fixed site frame ◄─────┘
                                │
   terrain horizon (skyline) ──►├──► Sun and Earth visibility (disc geometry, eclipse)
                                │
                                ├──► event search (sunrise, sunset, Earthrise, Earthset)
                                │
                                ├──► panel output ──► battery simulation ──► power condition
                                │
                                └──► conditions + score ──► up to 3 recommendations
```

### Time and positions

- Times are UTC milliseconds internally. The code converts to Terrestrial Time using the IERS leap-second table (TT minus UTC is 69.184 s in 2026). UT1 is approximated by UTC.
- The Moon, the Sun and Earth orientation come from [Astronomy Engine](https://github.com/cosinekitty/astronomy). Lunar orientation uses the IAU 2009 rotation model, and sites are placed in the Moon's mean-Earth frame with a radius of 1737.4 km, matching NASA QuickMap and JPL Horizons conventions (longitude east-positive).
- The Sun is drawn at its true size and distance. The Moon has no atmosphere, so there is no refraction: sunset is the Sun's upper limb touching the skyline.

### Terrain and the skyline

At the poles the Sun stays within about 1.5 degrees of the horizon, so terrain decides what is lit. For every catalogue site the app uses a precomputed horizon (720 azimuth samples, 0.5 degree steps) cast from three layers of elevation data:

- **Near field (about 0.5 km):** LROC NAC digital terrain models.
- **Mid field (about 10 km):** SLDEM2015 and LOLA polar grids.
- **Far field (to about 200 km):** LOLA elevation grids.

For any other coordinate on the Moon, a global LOLA LDEM_16 grid (1.9 km posting) is delivered as 72 on-demand tiles, and the app casts a regional horizon from it. Terrain data is checksummed on load and failures are reported, never silently replaced by a smooth sphere.

### Visibility and events

- **Sun:** visible while any part of its disc is above the skyline, minus the part hidden by the Earth during lunar eclipses (the Earth is modelled as a sphere with no atmosphere). The result is a visible fraction from 0 to 1.
- **Earth:** visible while the centre of its disc is above the larger of the skyline and a minimum elevation (0 degrees by default).
- **Events:** the app scans the mission window in 30-minute steps and halves intervals down to 10 seconds. It uses mathematically derived bounds on how fast each visibility margin can change to prove that an interval contains no event, so short passes are not missed. Events are located to within 0.5 seconds. Where the search cannot decide, the interval is reported as unresolved, not guessed.

### Power model

The default lander is an inspired-by-NASA-ILN solar-plus-battery teaching configuration:

| Parameter | Default |
|---|---|
| Solar panels | 2 fixed vertical panels (east and west), 0.54 m by 0.54 m each |
| Panel efficiency / output cap | 30 % / 100 W |
| Solar constant | 1361 W/m² at 1 AU, scaled by the Sun's distance |
| Night load | 23 W, continuous |
| Communication load | 5 W while the Earth is visible |
| Battery | 12,000 Wh, starts full, 20 % reserve |
| Charge and discharge efficiency | 95 % each; 90 % bus efficiency |

Panel output follows `P = S · η · Σ(area · f · max(0, n·s))`, capped at the output limit, where `f` is the visible Sun fraction after terrain and eclipse and `n·s` is the cosine between each panel's normal and the Sun direction. The battery is then simulated across the mission in time steps, tracking charge, loads, efficiencies and the reserve. The power condition passes only if the lander never falls below its reserve.

All parameters can be changed in the More settings panel and restored to defaults.

### Honest uncertainty: pass, fail, unknown, error

Every condition has four possible outcomes. `unknown` is never turned into `fail` or `0`, and a proven failure is the only thing that rules a site out. If an input is uncertain, the model computes lower and upper bounds (for example a bounded power result) instead of a single made-up number. A site is scored only when all four conditions pass.

### Scoring and recommendation

The score is `S = 100 · (wL·L + wC·C + wT·T)`, with default weights 0.50 for sunlight (L), 0.30 for Earth visibility (C) and 0.20 for terrain (T), normalised before use. Sites are ordered by score, with deterministic tie-breaking and a spread rule so the same input always gives the same list. The score is a ranking aid for comparing candidates. It is not a probability of landing success.

### Two assessment modes

- **Regional estimate (default):** uses the global terrain data and a regional slope screen, and runs the same event, power and communication models on a nominal skyline. If no catalogue site qualifies, the app searches the whole Moon: a coarse 5 degree grid, proven exclusions, prioritised full evaluations under a time budget, then a 1 degree refinement around the best regions. The report states how much of the Moon was fully evaluated and whether the search was complete or partial. It lists the best points it evaluated, not a proven optimum.
- **Evidence-based:** applies strict data-quality gates and refuses to decide when the evidence is incomplete. With the terrain data published at the time of writing, the 12 catalogue horizons are only partially covered, so this mode reports `unknown` for them rather than guessing.

### Candidate catalogue

The catalogue is a registry of 12 historical lunar sites with published coordinates from NASA NSSDCA: Apollo 11, 12, 14, 15, 16 and 17, Surveyor 7, Luna 16, Chang'e 3, 4 and 5, and Chandrayaan-3. They give the app real places with known terrain products and hardware dimensions to evaluate. The catalogue stores no results; evaluation happens at runtime.

### Transit estimate and routes

The app estimates Earth-to-Moon travel time as the straight-line distance between the launch point and the landing point divided by an effective speed (1.5 km/s by default), solving for the launch instant so the Moon and the rotating Earth are in the right places. This is a simplified estimate, not an orbit, fuel or launch-window analysis. The route drawn in the 3D scene is an illustrative curve, and its length feeds no result.

### Architecture

- **Physics (`src/physics`):** time scales, frames, ephemeris, horizon casting, disc visibility. Internal and heavily tested.
- **Simulation (`src/sim`):** the public calculation API: visibility, events, PV, energy, footprint, conditions, scoring, search, transit. It never imports UI or scene code.
- **Worker (`src/sim/worker`):** the whole calculation runs in a Web Worker. Requests carry a fingerprint of the inputs, settings and data versions, results are cached (LRU of 8), only the active request can update the screen, and a job that exceeds its budget is stopped and reported as an error, never as "no eligible sites".
- **State (`src/state`):** Zustand stores for inputs, the task, the clock, custom sites and routes.
- **Scene (`src/scene`):** React Three Fiber scene with true-scale bodies, a logarithmic depth buffer and raycast picking of Moon coordinates.
- **UI (`src/ui`):** sidebar, results, timeline, hover readout, reset dialog.
- **Details (`src/details`):** a separate page (`details.html`) that opens from a snapshot of the finished task stored in IndexedDB, so it does not load the 3D scene and does not recompute results.

### Validation

The physics layer is tested against JPL Horizons at 27 fixed epochs between 2016-11-14 and 2036-11-14, plus per-site samples and a separate holdout set whose error budgets were fixed first. Examples from the project's own tests:

| Item | Largest difference found |
|---|---|
| Geocentric Moon position vs DE441 | 13.6 km |
| Geocentric Sun direction | 1.3 arcsec |
| Sun and Earth direction from 14 lunar sites | 27.6 and 10.7 arcsec |
| Earth site positions | 0.16 km |

These are discrete samples, so they describe behaviour at those instants and not at every instant. Run `npm test` to repeat them.

## Limits and what this is not

- The recommendation score is not a landing-success probability, and the terrain thresholds (5 degree slope, 0.3 m obstacles over a 3 m footprint) are project screening values, not a NASA or ALHAT certification.
- Communication means geometric Earth visibility. There is no antenna, ground station, link budget or relay model.
- Dust, temperature and ageing losses are not modelled (loss factor of 1).
- Terrain from the global grid is regional (1.9 km posting). Footprint-scale hazards are only assessed where high-resolution terrain products exist.
- The app does not model orbits, fuel, launch windows or descent.
- Values the project could not source stay unknown. They are never filled with a number. Every constant, dataset and assumption is listed in [`sources.md`](sources.md) with its verification status.

## Getting started

Requirements: Node.js and npm.

```bash
npm install
npm run dev        # start the dev server
```

Data files in `public/data` are generated by the scripts in `tools/` (`buildDem.mjs`, `buildGlobalTiles.mjs`, `buildSiteTerrain.mjs`, `fetchHorizonsReference.mjs`). The shipped files are already included.

## Tech stack

React 19, TypeScript, Vite, React Three Fiber, drei and three.js, Zustand, Astronomy Engine, Web Workers and Vitest.

## Data and credits

Terrain and imagery come from NASA and partner missions: LRO LOLA and LROC (NAC DTMs), SELENE Terrain Camera (SLDEM2015), the NASA Scientific Visualization Studio CGI Moon Kit, Blue Marble from NASA Earth Observatory, and reference positions from NASA NSSDCA and JPL Horizons. The full register with versions and limits is in [`sources.md`](sources.md), and the simulation API is documented in [`docs/SIM_API.md`](docs/SIM_API.md).

## Contributors

- [Jace Cabrera](https://github.com/jacecabrera) and Yucheng Fu, who wrote most of the code
- [Bowen Wan](https://github.com/Bowen-Wan)
- Gavin Li
