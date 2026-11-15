# Simulation API

The simulation layer computes where the Sun and Earth are, relative to a point on the Moon, for any date.
UI code should import only from `src/sim` (`import { skyAt, compareSites, ... } from '../sim'`).
Everything in `src/physics/` is internal and covered by tests.

## Conventions

| Quantity | Convention |
|---|---|
| Time | milliseconds since the Unix epoch, UTC (`Date.getTime()`) |
| Latitude | degrees, north positive |
| Longitude | degrees, **east positive** (matches NASA QuickMap / Moon Trek and JPL Horizons) |
| Azimuth | degrees clockwise from local north, 0..360 |
| Elevation | degrees above the local horizontal plane; negative = below |
| Distance | kilometres |
| Scene | 1 unit = 1000 km, Earth at the origin, Y up (celestial north) |
| Moon radius | 1737.4 km (IAU; same as Horizons) |

"Up" means any part of the body's disc is above the mask. There is no atmosphere, so there is no refraction:
sunset is the Sun's upper limb touching the horizon.

> **Status note (2026-11-14, step 02):** Requirements v0.7 §5 define Earth visibility by the disc **centre** above
> max(terrain horizon, minimum elevation, default 0°). The current code applies the Sun's any-part-of-disc rule to Earth too.
> The fix is scheduled for step 09 (see `docs/step-02-requirements-map.md`, R02-58).

## 3D scene

```ts
const s = sceneState(new Date(t))
s.moonPosition   // [x, y, z] scene units
s.moonRotation   // 3x3 row-major, mesh-local axes -> scene axes
s.earthRotation  // same, for the Earth mesh (Greenwich sidereal time; visual only)
s.sunDirection   // unit vector Earth -> Sun
```

Mesh-local axes follow the texture convention: longitude 0 = +X, east = -Z, north = +Y. To apply a rotation:

```ts
const m = new Matrix4().set(
  R[0][0], R[0][1], R[0][2], 0,
  R[1][0], R[1][1], R[1][2], 0,
  R[2][0], R[2][1], R[2][2], 0,
  0, 0, 0, 1,
)
group.quaternion.setFromRotationMatrix(m)
```

`latLonToVec3(lat, lon, r)` gives a surface point in mesh-local axes (for markers).

## Site calculations

```ts
type Site = { name?: string; lat: number; lon: number; horizon?: Horizon }

skyAt(site, date, opts?)           // { sun, earth, sunUp, earthUp }; each body has elevation, azimuth, angularRadius, distanceKm
windows(site, 'sun' | 'earth', startMs, endMs, opts?)   // Interval[] of { start, end } when the body is up
nextEvent(site, target, tMs, opts?) // { up, next: { t, kind: 'rise' | 'set' } | null, ms }  -> "time to sunset / Earthset"
compareSites(sites, startMs, endMs, opts?)  // per site: sun, earth, operational (Sun up AND Earth up)
panelFactor(elevationDeg, tiltDeg = 0)      // relative solar-panel power from geometry only
```

`opts`: `{ maskDeg?: number; horizon?: Horizon }`. A body is up while its disc clears `max(maskDeg, horizon(azimuth))`.
`compareSites` results carry `intervals` (the windows), `fractionUp`, `longestUpMs`, `longestDownMs` and `windows` (a count).
Use a window longer than one lunar day (about 30 days) so "longest" values are not clipped by the window edges.

> **Status note (2026-11-14, step 02):**
> - Mission metrics must be computed over exactly [landing time, landing time + mission duration] (v0.7 §2, §7).
>   Do not lengthen the window to avoid clipping; clipping at the mission edges is the intended behaviour.
>   The 30-day advice above applies only to exploratory comparisons.
> - `nextEvent` returns the next event of either kind. When the body is down, it returns a **rise**, not a set.
>   v0.7 §7 "Time to next sunset / Earthset" needs the next visible-to-not-visible transition, plus the search range when none is found.
>   The fix is scheduled for step 10 (R02-70).

### Terrain

`Site.horizon` is a function azimuth -> skyline elevation. `horizonFromProfile(samples)` builds one from evenly spaced
values (e.g. 360 values, 1 degree apart, starting at north). **Without it the Moon is a smooth sphere.**
At the poles the Sun stays within about 1.5 degrees of the horizon, so terrain decides what is lit; sphere-only
south-pole results show too much sunlight. Show that caveat in the UI until profiles are loaded.

The terrain API provides horizon profiles from LOLA elevation data:

```ts
await loadTerrain()                       // fetch the shipped LDEM_4 grid (2.1 MB)
const site = siteAt(lat, lon)             // Site with its terrain horizon attached
const t = terrainAt(lat, lon)             // { elevationM, slopeDeg, aspectDeg, baselineM, resolutionKm }
const profile = horizonProfileAt(lat, lon) // 360 skyline elevations, 1 deg step
const h = horizonAt(lat, lon)             // Horizon function for Site.horizon
```

At 4 pixels/deg the grid resolves features wider than about 7.6 km. Slopes are regional averages.
See `sources.md` for full limitations.

## Power viability

> **Status note (2026-11-14, step 02):** The API below is the current implementation. Its binary generation model,
> kW/kWh units, `stayMs` inside the device config and placeholder defaults conflict with requirements v0.7 §2 and §5.
> Energy `viable` is also not a landing eligibility result. See `docs/step-02-requirements-map.md` (R02-10, R02-38 to R02-48).
> Replacement is scheduled for steps 03, 05, 11 and 12.

```ts
import { assessViability, isViable, DEFAULT_POWER_CONFIG } from '../sim'
import type { PowerConfig, PowerResult } from '../sim'

const result: PowerResult = assessViability(site, landingTimeMs, config)
result.viable            // true if the spacecraft survives the entire stay
result.reason            // null, or a string explaining the failure
result.lowestChargeKwh   // minimum battery charge reached
result.lowestChargeAtMs  // when it occurred
result.minReserveMarginKwh // lowest charge minus the reserve (negative = breached)
result.totalDeficitKwh   // cumulative unmet energy (0 if viable)
result.totalSolarKwh     // total solar energy generated
result.totalConsumedKwh  // total energy consumed
result.timeline          // PowerState[] for every simulation step
result.sunIntervals      // the sun-up windows used

const quick = isViable(site, landingTimeMs, config)
quick.viable             // boolean
quick.reason             // string | null
```

The solar generation model is binary: any sunlight = full rated output, no sunlight = zero.
See `sources.md` for the complete list of assumptions and limitations.

Variable consumption is supported through `PowerSchedule`:

```ts
const schedule = [
  { startMs: 0, endMs: 10 * 3600000, loadKw: 1.0 },       // low-power phase
  { startMs: 10 * 3600000, endMs: config.stayMs, loadKw: 3.0 }, // full operations
]
const result = assessViability(site, landingTimeMs, config, { schedule })
```

User inputs are managed in `src/state/missionStore.ts` (Zustand). The sim layer receives
values as plain function arguments and does not depend on the store.

## Performance

About 40,000 `skyAt`-level evaluations per second in Node. Three sites over 400 days at a 1 hour step takes
about 0.75 s. Run long scans in a Web Worker, and keep the step small enough to catch short passes (30 min default).

## Validation status

| Item | Status |
|---|---|
| Moon orientation, sub-Earth and sub-solar lat/lon vs JPL Horizons (MOON_ME, DE441) | within 18 arcsec (0.005 deg) at 5 times, 2026-11-13 00:00 to 2026-11-14 00:00 UTC; see `sources.md` and `physics/horizonsValidation.test.ts` |
| Site elevation and azimuth vs Horizons (observer on the Moon) | pending; request settings are in `sources.md` |
| Terrain horizon | implemented at 4 pixels/deg (~7.6 km) globally via LOLA GDR; see `sources.md` for limitations |
| Earth orientation | checked against sub-solar longitude and declination to a few degrees; ignores precession since J2000 (~0.3 deg) |
| Solar radius 695,700 km | IAU 2015 Resolution B3 nominal value (see `sources.md`) |

## Sources

Every constant, dataset and texture used by the code is listed in `sources.md` at the repository root.

## Tests

`npx vitest run` runs all tests; `npx tsc -b` should print nothing.
