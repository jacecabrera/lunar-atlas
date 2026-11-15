# Simulation API

The simulation layer computes where the Sun and Earth are, relative to a point on the Moon, for any date.
UI and scene code import only from `src/sim` (`import { skyAt, compareSites, ... } from '../sim'`; adjust the
relative path to the importing file). Everything in `src/physics/` is internal and covered by tests.
`src/sim/index.ts` only re-exports; sim modules import each other directly. Data contracts (mission inputs,
assessment states, serializable horizons, task identity, snapshots) are described in `docs/step-03-contracts.md`.

## Conventions

| Quantity | Convention |
|---|---|
| Time | absolute: milliseconds since the Unix epoch, UTC (`Date.getTime()`), suffix `Ms`; relative to landing: suffix `OffsetMs`. Internally TT = UTC + 32.184 s + leap seconds (`physics/timeScale.ts`); UT1 is taken as UTC |
| Latitude | degrees, north positive |
| Longitude | degrees, **east positive** (matches NASA QuickMap / Moon Trek and JPL Horizons) |
| Azimuth | degrees clockwise from local north, 0..360 |
| Elevation | degrees above the local horizontal plane; negative = below |
| Distance | kilometres |
| Power / energy | W / Wh (energy at the battery's internal terminal); integration time in hours. Conversions in `src/sim/units.ts` |
| Mission duration | entered in Earth days (24 h), carried as ms (`MissionInput.durationMs`); not the Earth-Moon transit time |
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
s.earthRotation  // same, for the Earth mesh: GAST + nutation + precession, same rotation as earthSiteGeocentric()
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
compareSites(sites, startMs, endMs, opts?)  // per site: sun, earth, sunAndEarthVisible (Sun up AND Earth up; geometry only)
panelFactor(elevationDeg, tiltDeg = 0)      // panel facing the Sun's azimuth; NOT the fixed east/west panel model
```

`opts`: `{ maskDeg?: number; horizon?: Horizon }`. A body is up while its disc clears `max(maskDeg, horizon(azimuth))`.
`compareSites` results carry `intervals` (the windows), `fractionUp`, `longestUpMs`, `longestDownMs` and `windows` (a count).
Use a window longer than one lunar day (about 30 days) so "longest" values are not clipped by the window edges.

> **Status note (2026-11-14, step 02):**
> - Mission metrics must be computed over exactly [landing time, landing time + mission duration] (v0.7 §2, §7).
>   Do not lengthen the window to avoid clipping; clipping at the mission edges is the intended behaviour.
>   The 30-day advice above applies only to exploratory comparisons.
> - `compareSites(...).sunAndEarthVisible` (named `operational` before step 03) is the overlap of the two visibility
>   windows. It does not mean the lander can operate, has power, or has a radio link, and it is not eligibility.
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
const profile = horizonProfileAt(lat, lon) // skyline elevations; 360 values only with the default 1 deg step
const h = horizonAt(lat, lon)             // Horizon function for Site.horizon
const data = horizonDataAt(lat, lon)      // serializable HorizonData with source and model parameters
```

`azimuthStepDeg` must divide 360 (otherwise these functions throw). `horizonDataAt` returns
`{ status: 'unavailable', code: 'not-loaded' }` when no grid is loaded instead of throwing, so the new evaluation
flow can record "not evaluated". Rebuild the function with `runtimeHorizon(data)`, or gate an evaluation with
`requireHorizon(data)`, which maps missing data to `unknown` and a failed request to `error` (never to a smooth sphere).
Workers and snapshots carry `HorizonData` / `SerializableSite`, never a `Horizon` function.

At 4 pixels/deg the grid resolves features wider than about 7.6 km. Slopes are regional averages.
See `sources.md` for full limitations.

## Power viability (legacy model)

> **Status note (step 03):** This is still the pre-v0.7 binary model (any sunlight = full rated output) and is
> replaced in steps 11 and 12. Step 03 changed its interface only: W/Wh units, the mission duration comes from a
> `MissionWindow` instead of the config, schedule segments are offsets from landing, the placeholder defaults are
> isolated as `LEGACY_PLACEHOLDER_POWER_CONFIG`, and `simulatePower` validates its inputs like `assessViability`.
> `viable` is a legacy energy result only; it is not landing eligibility and must not become a `pass` condition.

```ts
import { assessViability, isViable, LEGACY_PLACEHOLDER_POWER_CONFIG, missionWindow } from '../sim'
import type { LegacyPowerConfig, LegacyPowerResult } from '../sim'

const window = missionWindow(input)        // { startMs: landing, endMs: landing + duration }, absolute UTC ms
const result: LegacyPowerResult = assessViability(site, window, LEGACY_PLACEHOLDER_POWER_CONFIG)
result.viable              // true if the legacy model survives the entire stay
result.reason              // null, or a string explaining the failure
result.lowestEnergyWh      // minimum stored energy reached
result.lowestEnergyAtMs    // when it occurred (absolute UTC ms)
result.minReserveMarginWh  // lowest energy minus the reserve (negative = breached)
result.totalDeficitWh      // cumulative unmet energy (0 if viable)
result.totalSolarWh        // total solar energy generated
result.totalConsumedWh     // total energy consumed
result.timeline            // PowerState[] for every simulation step (tMs absolute UTC)
result.sunIntervals        // the sun-up windows used (absolute UTC)

const verdict = isViable(site, window, config)  // { viable, reason }; still runs the full simulation
```

Callers holding kW/kWh values convert them explicitly with `legacyPowerConfigFromKw({ normalLoadKw, ... })`.
See `sources.md` for the complete list of assumptions and limitations.

Variable consumption is supported through `PowerSchedule`. Segment times are offsets from landing:

```ts
const H = 3_600_000
const schedule = [
  { startOffsetMs: 0, endOffsetMs: 10 * H, loadW: 1000 },                               // low-power phase
  { startOffsetMs: 10 * H, endOffsetMs: window.endMs - window.startMs, loadW: 3000 },   // full operations
]
const result = assessViability(site, window, config, { schedule })
```

Mission inputs and task state live in `src/state/missionStore.ts` (`useMission`: `draft`, `legacyPower`, `task`).
The sim layer receives values as plain function arguments and does not depend on the store.

## Frames, time scales and physical endpoints (step 06)

| Frame | Origin and axes | Used for |
|---|---|---|
| EQJ | Geocentric; J2000 mean equator and equinox (Astronomy Engine; no ICRS frame bias, ~0.02 arcsec) | All inertial vectors, transit endpoints |
| Earth-fixed | x = Greenwich meridian on the equator, y = 90 E, z = true pole of date (no polar motion) | Launch sites; `earthFixedToEqj(date)` rotates into EQJ |
| Moon-fixed | x = lon 0 / lat 0, y = 90 E, z = north; IAU 2009 orientation (`eqjToMoonFixed`) | Sky directions at lunar sites |
| Local (lunar site) | east, north, up on the 1737.4 km sphere; azimuth clockwise from north | `skyAt`, `siteSky` |
| Scene | EQJ scaled to 1 unit = 1000 km with (x, y, z) -> (x, z, -y) | Rendering only |

- Earth latitude is geodetic on Astronomy Engine's ellipsoid (6378.1366 km, b/a = 0.996647180302104); height is above that ellipsoid. Lunar latitudes are planetocentric on a sphere. Longitudes are east positive; azimuth is clockwise from north.
- Site vectors are geometric (no light-time, no aberration) at one instant. Apparent directions seen from the Moon differ by up to ~28 arcsec.
- DE421 mean Earth coordinates (candidates, LOLA, SLDEM, NAC DTMs) are used directly in the IAU orientation; the measured orientation difference (17-31 arcsec, ~250 m at the surface) is within the 0.01 degree direction budget. Terrain lookups stay in mean Earth latitude and longitude and need no conversion.

```ts
import { earthSiteGeocentric, moonSiteGeocentric, separationKm, DEFAULT_LAUNCH_HEIGHT_M } from '../sim'

const launch = earthSiteGeocentric({ lat: 28.5, lon: -80.6 }, launchUtcMs) // heightM defaults to 0 m above the ellipsoid
const landing = moonSiteGeocentric({ lat: 0.67416, lon: 23.47314 }, landingUtcMs) // radiusKm defaults to 1737.4
launch.positionKm, landing.positionKm // EQJ, geocentric, geometric, km, each at its own instant
separationKm(launch, landing)          // straight-line endpoint distance; throws if the frames differ
```

Both functions throw `RangeError` on non-finite or out-of-range input. They give positions only: the iteration
launch = landing - distance / speed belongs to step 14. `ttMinusUtcSeconds(ms)`, `taiMinusUtcSeconds(ms)` and
`LEAP_SECONDS_VALID_UNTIL_UTC` expose the time scale; leap seconds after the IERS table's expiry are assumed not to occur.

## Candidate catalog and mission defaults

Two bundled JSON files in `src/data/` are read through validating loaders exported from `src/sim`. The loaders never trust a type
assertion: they check the schema, ranges, units, source IDs and cross-references, and throw with every problem listed if a file is invalid.

```ts
import { loadCandidateCatalog, loadMissionDefaults, defaultAdvancedSettings, toCandidateRecord, initialSiteAssessment } from '../sim'

const catalog = loadCandidateCatalog()      // 12 historical points, terrain product register; dataVersion 'v0.1'
const c = catalog.candidates[0]
c.coordinate                                // NSSDCA lat/lon plus the printed text (latText, lonText, sourceText)
c.alternateCoordinates                      // LROC shapefile coordinate and uncertainty, stored beside it, never over it
c.hardware.footprintOverlap.level           // 'geometric-derivation' | 'possible' | 'insufficient-data' | 'direct-evidence'
c.terrain.localDtms                         // NAC DTM parameters and the single-point sample read in step 04
toCandidateRecord(c, catalog)               // CandidateRecord (assessment contract); coordinate unchanged
initialSiteAssessment(c)                    // every condition unknown: landingAllowed null, eligibleForRecommendation false

const defaults = loadMissionDefaults()      // preset 'iln-inspired-solar-lander', dataVersion 'v0.1'
defaults.settings                           // AdvancedSettings in W, Wh, fractions, km/s
defaults.interaction                        // clock and Clear defaults (configuration only)
defaults.parameters                         // raw table: value, unit, kind, sourceIds, assumptionIds, verification, note
defaultAdvancedSettings()                   // a fresh deep copy, used by the store for initialisation and reset
```

- The catalog is a registry. It stores no evaluation result and the validator rejects `landingAllowed`, `eligibleForRecommendation`,
  `conditions`, `score` and similar keys anywhere in it.
- Unknown values are `null` (a version, an accuracy, a hardware dimension). They are never written as 0.
- Source coordinates keep their printed text. Rounding half-steps come from `quantizationHalfStepM()` and are derived, not published, errors.
- The reserve is stored once as `reserveFraction`. Use `reserveEnergyWh(device)` for Wh.
- The three main task inputs and the mission duration are not in the defaults; the validator rejects a pre-filled value.
- `withDataVersions(versions, { catalog, defaults })` puts `catalogId@dataVersion` and `presetId@dataVersion` into the result identity. The
  versions are fixed strings in the files, never a load time.
- Loading these files does not evaluate anything and does not load terrain. The new settings are not wired into the legacy power model.
- Source IDs in the files (`SRC-`, `ASM-`, `REQ-`) refer to the register in `sources.md`; a test checks that each one exists there.

## Performance

About 40,000 `skyAt`-level evaluations per second in Node. Three sites over 400 days at a 1 hour step takes
about 0.75 s. Run long scans in a Web Worker, and keep the step small enough to catch short passes (30 min default).

## Validation status

Measured against the JPL Horizons API in step 06 (`src/physics/reference/horizons-step06.json`, 27 fixed epochs from
2016-11-14 to 2036-11-14 plus per-site samples; `physics/horizonsReference.test.ts`). Discrete samples only: this shows
the behaviour at those instants, not at every instant.

| Item | Result | Budget |
|---|---|---|
| Geocentric Moon position vs DE441 | max 13.6 km (mean 10.7 km), from the library's truncated lunar theory | 67 km |
| Geocentric Sun direction / distance | max 1.3 arcsec / 1570 km | 0.01 deg / 10,000 km |
| Sub-solar point vs MOON_ME (light-time convention matched) | max 30.5 arcsec | 0.01 deg |
| Lunar orientation: IAU 2009 vs DE421 mean Earth (12 well-conditioned epochs) | 16.8-30.6 arcsec, time-dependent | 0.01 deg |
| Sun / Earth direction from 14 lunar sites (168 rows, incl. near-horizon) | max 27.6 / 10.7 arcsec | 0.01 deg |
| Earth site positions (6 sites, 2016-2036) | max 0.16 km | 1 km |
| Time scale | TT - UTC = 69.184 s since 2017 (IERS table) | exact up to the table's expiry |
| Historical sample (2026-11-13/14, 5 epochs) | within 0.006 deg (`physics/horizonsValidation.test.ts`) | kept as regression |
| Terrain horizon | LDEM_4 only (~7.6 km); see `sources.md` | step 07 |

## Sources

Every constant, dataset and texture used by the code is listed in `sources.md` at the repository root.

## Tests

`npx vitest run` runs all tests; `npx tsc -b` should print nothing.
