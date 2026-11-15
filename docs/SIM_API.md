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
type Site = { name?: string; lat: number; lon: number; horizon?: Horizon; radiusKm?: number } // radiusKm: observer distance from the Moon centre

skyAt(site, date, opts?)           // { sun, earth, sunUp, earthUp }; each body has elevation, azimuth, angularRadius, distanceKm
windows(site, 'sun' | 'earth', startMs, endMs, opts?)   // Interval[] of { start, end } when the body is up
nextEvent(site, target, tMs, opts?) // { up, next: { t, kind: 'rise' | 'set' } | null, ms }  -> "time to sunset / Earthset"
compareSites(sites, startMs, endMs, opts?)  // per site: sun, earth, sunAndEarthVisible (Sun up AND Earth up; geometry only)
panelFactor(elevationDeg, tiltDeg = 0)      // panel facing the Sun's azimuth; NOT the fixed east/west panel model
```

`opts`: `{ maskDeg?: number; horizon?: Horizon; observerRadiusKm?: number }`. Step 09 rules (preview functions; formal visibility is
`visibilityModel` below): the **Sun** is up while some of its disc is above the skyline `horizon(az)` (negative values kept; flat 0 deg
without a horizon; `maskDeg` only when given); the **Earth** while its disc **centre** is strictly above `max(horizon(az), maskDeg ?? 0)`.
These functions do not apply lunar eclipses.
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

At 4 pixels/deg the grid resolves features wider than about 7.6 km. Slopes are regional averages. This LDEM_4 path is a
preview: its `HorizonData` has `coverage.nearField: 'absent'`, so `requireHorizon` rejects it for formal use.
See `sources.md` for full limitations.

### Site terrain for the candidates (step 07)

```ts
import { siteTerrain, createSiteTerrainStore, TerrainLoadError, requireHorizon, toRuntimeSite } from '../sim'

const t = await siteTerrain.load('apollo-11')  // shared promise per (terrain-v1, site); a failed load is retried on the next call
siteTerrain.state('apollo-11')               // not-loaded | loading | ready | insufficient (+ reasons) | failed (+ TerrainLoadError)
t.elevation                                  // { valueM, source, quality, confidenceCode, regionalValueM }, metres above 1737.4 km
t.observerRadiusKm()                         // 1737.4 + elevation/1000 + 0 m observer height (ASM-OBSERVER-HEIGHT)
t.horizon                                    // HorizonData: 720 samples (0.5 deg), observer, coverage, products
t.horizonFor(2)                              // unavailable 'not-precomputed': only the published observer height has a horizon
t.near                                       // NAC grid (+/-0.5 km) + confidence codes, or null
t.regional                                   // SLDEM2015 / LDEM_60S_60M grid (+/-10 km)
t.regionalSlope(baselineM)                   // baseline raised to >= 2 regional pixels; never a 3 m footprint slope
const site = toRuntimeSite(t.toSerializableSite()) // Site with horizon (complete coverage only) and radiusKm
requireHorizon(t.horizon)                    // formal gate, see below
```

- Files: `public/data/terrain/v1/index.json` and `<siteId>/{manifest.json, horizon.json, regional.i16, near.i16, near-conf.u8}`, read
  from `${BASE_URL}data/terrain/v1/`. Byte lengths and FNV-1a checksums are verified; `TerrainLoadError.kind` is `not-found`, `network`,
  `corrupt` or `parse`. The cache key contains the data version and site; the observer height and cast parameters are fixed by the
  data version (a different height gives `not-precomputed`, not a reused horizon).
- One elevation per site feeds the horizon (`horizon.observer.radiusKm`), `skyAt` / `siteSky` (`Site.radiusKm`) and
  `moonSiteGeocentric({ radiusKm })`.
- `HorizonData.coverage`: per-azimuth `sampleStatus` (`complete` | `lower-bound`), `coveredToKm`, `governingKm`, `governingSource`,
  `uncertaintyDeg`, and `nearField` (`screened` | `unscreened` | `absent`). A lower bound means the true horizon may be higher.
- `requireHorizon` accepts only complete coverage, a screened near field, an observer elevation of quality `measured` or
  `interpolated`, a near-field product chosen without relaxed gates and converged sampling (ASM-HORIZON-CONVERGENCE). It returns
  **every** failed check: `horizon-not-loaded` / `horizon-<code>` (unavailable), `horizon-coverage-unknown`, `horizon-no-near-field`,
  `horizon-near-field-unscreened`, `horizon-observer-elevation-quality`, `horizon-quality-unknown`, `horizon-degraded-product`,
  `horizon-convergence-not-checked`, `horizon-not-converged`, `horizon-partial-coverage`. All 12 candidates currently give unknown.
- `HorizonData.quality` (selection tier, convergence checks) and `HorizonData.inputs` (offline crops the horizon was cast from; larger
  than the published grids). A `lower-bound` azimuth is a lower bound with respect to missing terrain only: a body clearly below it is
  hidden, above it visibility is unknown; the evaluated samples still carry `uncertaintyDeg`.
- Published grid values have a storage quantisation step (0.02 m / 0.25 m); accuracy is in `manifest.files.*.accuracy`.
- `runtimeHorizon(data)` returns null for partial coverage; `runtimeHorizon(data, { allowPartial: true })` is for labelled previews only.
- Loading does not evaluate any landing condition and does not run in a Worker yet (step 15).

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

### Formal Sun and Earth visibility (step 09)

```ts
import { visibilityModel } from '../sim'

const m = visibilityModel(siteTerrain.toSerializableSite(), { earthMinElevationDeg: settings.earthMinElevationDeg })
m.status                 // 'ready' only when the horizon passes requireHorizon (lower-bound azimuths handled per instant)
m.reasons                // gate reasons when 'unavailable'
m.observerRadiusKm       // from horizon.observer (same elevation as horizon and endpoint)
const s = m.sunAt(tMs)   // geometry, terrainVisible, terrainVisibleFraction, earthOccultedFraction, visibleFraction,
                         // visibleFractionUpperBound, sunlit, blockedBy: ['terrain' | 'earth'], reasons
const e = m.earthAt(tMs) // geometry, skylineDeg, skylineIsLowerBound, marginDeg, visible, reasons
```

- Sun: `terrainVisible` = positive disc area above the skyline (no minimum elevation); `visibleFraction` = part of the disc above the
  skyline and outside the Earth (0..1; not panel power, no incidence angle); `sunlit` = `visibleFraction > 0` after terrain and Earth.
- Earth: `visible` = centre strictly above max(skyline at its azimuth, minimum elevation).
- Unknown is `null`, never `false` or 0. Exceptions that do not depend on terrain are decided even without a horizon: Earth centre at or
  below the minimum elevation (`visible: false`), Sun entirely behind the Earth (`sunlit: false`).
- Lower-bound skyline: disc wholly below it -> hidden; otherwise `null` with `visibleFractionUpperBound`.
- Lunar eclipse: Earth as a sphere of 6378.137 km, no atmosphere (ASM-ECLIPSE-SPHERE); combined with terrain on the same disc.
- Strict boundaries: exact tangency is not visible; skyline interpolation is exact for level segments so equality tests are not moved
  by rounding. No extra epsilon, no refraction.

### Photovoltaic output (step 11)

```ts
import { pvPowerAt, pvFromSun } from '../sim'

const p = pvPowerAt(visibilityModel, { device: settings.device, model: settings.model }, tMs)
p.status   // 'determined' (powerW) | 'bounded' (visible fraction unknown: lowerW..upperW) | 'error'
p.powerW, p.lowerW, p.upperW, p.rawW, p.limited, p.irradianceWm2, p.sunDistanceKm, p.panels[i].incidenceCos
```

- S = S_1AU (AU / d)^2; P_raw = S eta_PV sum_j A_j f max(0, n_j . s) k_loss; P_PV = min(P_raw, pvOutputLimitW) on the whole array.
  Local east-north-up frame; panel azimuth clockwise from north, tilt up from the horizontal plane (90 = vertical); fixed panels.
- f is `SunVisibility.visibleFraction` (terrain and Earth together), shared by both panels (ASM-PV-SHARED-FRACTION); the incidence
  cosine is taken at the disc centre. f is not an efficiency; k_loss = 1 means losses not modelled.
- Unknown f gives `bounded` with lowerW = 0 and upperW from `visibleFractionUpperBound` or 1 - Earth cover; never a binary
  "sun up = 100 W". 0 W is `determined` only when f = 0 is known or the Sun is behind every panel.
- Invalid settings throw RangeError; visibility failures give `status: 'error'`.
- The legacy binary model (`simulatePower`, `assessViability`) stays isolated and must not feed the power condition.

### Conditions, scores and recommendations (step 13)

```ts
import { evaluateCatalog, catalogCandidateInputs, recommend } from '../sim'

const inputs = catalogCandidateInputs({ candidate, terrain }, catalog, settings, missionWindow) // footprint, energy, statistics
const r = recommend(inputs[], settings)  // or evaluateCatalog(runs, catalog, settings, missionWindow)
r.status            // 'ok' | 'invalid-settings' (weights)
r.recommendations   // 0..limits.maxRecommendations, historical only, never padded (Recommendation contract)
r.ranked            // every scored candidate in order, with score, quantised score, parts L/C/T, nearestPreviousM
r.evaluations       // SiteAssessment (four conditions + summary) per candidate, sorted by ID
r.excluded          // physicalFail / insufficientData / serviceError / notScored / beyondLimit / customNotRecommended
```

- Conditions: terrain = formal footprint; power = energy condition; communication = positive time in Earth geometric visibility
  AND supplied load (proven: pessimistic supply; fail if the Earth is never visible, or if even the optimistic supply has no
  positive overlap; zero-length touches do not count); dataCompleteness (ASM-DATA-COMPLETENESS). Summary by summarizeConditions.
- Score only when all four pass and L, C and a passed footprint slope exist: S = 100 (wL L + wC C + wT T), normalised weights
  (invalid or all-zero weights: `invalid-settings`). C is Earth geometric visibility, not powered communication. No minimum score.
- Order: round(S x 100) descending, historical first, spread (ASM-RECOMMEND-SPREAD), stable ID; independent of input order.
- Geometry and supply only: no antenna, ground station, link budget or relay. The score is a preference, not a success probability.

### Loads, battery and supply (step 12)

```ts
import { assessEnergy, simulateBattery } from '../sim'

const e = assessEnergy(visibilityModel, settings, { startMs: landingMs, endMs: landingMs + stayMs }, { stepMs: 5 * 60_000 })
e.condition          // power condition: pass | fail | unknown | error, with every reason
e.status             // determined | bounded (unknown inputs bounded by two scenarios) | error
e.pessimistic        // PV lower bound, load upper bound: steps, firstFailure { tMs, cause }, minEnergyWh/Ms, suppliedIntervals, totals
e.optimistic         // PV upper bound, load lower bound
e.supply.proven      // times the specified load is supplied in the pessimistic case (for the communication check)
e.supply.possible    // ... in the optimistic case
e.earth.visible / e.earth.possible // proven / possible Earth geometric visibility
```

- P_device = baseLoadW + commLoadW x I_E (I_E from the formal Earth visibility, whole mission, independent of the Sun);
  P_bus = P_device / busEfficiency. PV efficiency, bus efficiency, charge and discharge efficiency are applied once each.
- deltaP = P_PV - P_bus; charge = min(surplus, chargeLimitW, room); discharge = min(demand, dischargeLimitW, energy above reserve);
  E += (eta_c charge - discharge / eta_d) dt[h]. PV to the load directly has no battery loss; no simultaneous charge and discharge;
  curtailment and unmet load are recorded. Reserve = capacity x reserveFraction (derived).
- Failure: unmet load (reserve reached with demand remaining, or demand above the discharge limit). The first failure is kept after
  recharging; supply may resume later (`suppliedIntervals`). Stored energy never goes below the reserve; the deficit is separate.
  Reaching the reserve exactly at the end with no further demand is not a failure.
- Unknown PV (bounded) and unknown Earth state are handled by the two scenarios; the update is monotone, so pessimistic success
  proves pass and optimistic failure proves fail (no later than its failure time); otherwise unknown. Unresolved event intervals
  count as unknown.
- Numerics: event segments split into equal steps <= stepMs, PV at step midpoints; an unmet energy below 1e-9 Wh is rounding.
- `simulateBattery` is the pure per-scenario simulation. The legacy `simulatePower` / `assessViability` / `isViable` remain isolated:
  their `viable` is the old binary model and is not the power condition or landing eligibility.

### Events, next set and mission statistics (step 10)

```ts
import { searchEvents, nextSet, missionStatistics } from '../sim'

const r = searchEvents(model, 'sun' | 'sun-terrain' | 'earth', startMs, endMs, { scanStepMs, minResolveMs, locateToleranceMs, maxEvaluations })
r.segments   // consecutive { start, end, state: true | false | null }
r.events     // { tMs, toleranceMs, kind: rise | set | unknown-start | unknown-end, cause: terrain | earth | min-elevation | data }
r.unresolved // intervals (<= minResolveMs) where a shorter window or gap cannot be excluded
r.status     // 'complete' | 'budget-exhausted' (searchedToMs tells how far)
nextSet(model, { target: 'sun' | 'earth', channel?, queryMs, searchMs? }) // status found | not-found | unknown | incomplete
missionStatistics(model, { startMs: landingMs, endMs: landingMs + stayMs })   // MissionStatistics
```

- Channels: `sun` = effective sunlight (terrain and Earth; an eclipse start is a `set` with cause `earth`), `sun-terrain` = terrain
  geometry only (sunset), `earth` = Earth centre rule. All states come from `visibilityModel`; nothing re-implements the rules.
- Discovery: an interval is accepted as event-free only when |m(a)| + |m(b)| > L (b - a) proves no sign change (L from
  ASM-SKY-RATE-BOUNDS and the skyline slope); otherwise it is halved down to 10 s, then reported as unresolved. Location to +/-0.5 s.
  Both ends unknown: the interval is unknown as a whole. A budget (400,000 evaluations) stops the search with `budget-exhausted`.
- `nextSet`: the next visible -> not-visible transition in [queryMs, queryMs + searchMs]; when not visible now, the set after the next
  rise; a set exactly at the query instant is not returned. `not-found` only for a fully checked range with no unknown or unresolved
  time; otherwise `unknown` or `incomplete`. `eventMs` / `msUntil` are null unless found. The search range is independent of the mission.
- `missionStatistics`: over exactly [landing, landing + stay]. Sunlit duration and fraction (effective), terrain-only Sun duration,
  eclipse duration, longest darkness, Earth duration / fraction / longest window / longest gap, Sun-and-Earth fraction, time-weighted
  mean and peak Sun centre elevation while sunlit (composite Simpson; null when never sunlit; negative values allowed), and an hourly
  `sunSeries`. `sunStatus` / `earthStatus` / `status`: complete, bounded (unresolved intervals; `resolutionUncertaintyMs`), incomplete
  (values null with reasons; `partial` gives the known parts and the unknown time, which is never counted as dark or visible).
- Geometry only: an Earth window is not a working link and sunlight is not power (steps 11-13).
- The older `findEvents`, `upIntervals`, `statusAt`, `windows`, `nextEvent` and `compareSites` are previews (30 min scan, no quality
  gate, no eclipses) and must not feed assessments.

### Footprint terrain conditions (step 08)

```ts
import { assessFootprint, footprintConfig, assessCandidateFootprint, defaultAdvancedSettings } from '../sim'

const config = footprintConfig(defaultAdvancedSettings()) // diameter, slope and obstacle limits from settings; policy factors
const a = assessFootprint({ site: { lat, lon, frame }, config, dtm, obstacleSurveys, hazards, hazardInventory })
a.terrain     // ConditionResult for SiteConditions.terrain: fail > error > unknown > pass, all reasons kept (failures first)
a.slope       // footprint maximum slope vs slopeLimitDeg (>= limit fails)
a.obstacles   // obstacles vs obstacleLimitM (>= limit fails); needs a capable, complete survey or fine DTM to pass
a.hazards     // known hazards with per-hazard overlaps: confirmed-overlap | possible-overlap | confirmed-clear | undetermined
a.data        // data adequacy: pass (adequate) | unknown (inadequate) | error (load failure); never 'fail'
assessCandidateFootprint(candidate, catalog, siteTerrainOrLoadErrorOrNull, config) // catalogue evidence -> assessFootprint
```

- Inputs are explicit (`FootprintDtm` with native posting, effective resolution, vertical error, registration, frame and confidence
  codes; `ObstacleSurvey` with detection limit and coverage; `KnownHazard` with relation to the site coordinate, frame, position errors,
  verified extents and obstruction height). The candidate ID is never used to decide.
- Uncertainties carry their statistic (`bound`, `90-percent`, `1-sigma`, `unknown`) and, for vertical errors, a scope
  (`height-difference`, `single-post`, `absolute`; only height differences support slope decisions). An unknown statistic never
  supports pass or fail; `FOOTPRINT_POLICY.sensitivityFactor` (3) only produces labelled what-if values (step 11 wrap-up).
- pass needs footprint-scale evidence: slope with cells <= diameter / 2 and the slope error (atan(sqrt 2 * e90 / baseline)) not
  reaching the limit at any placement allowed by the registration; obstacles with a capable complete survey or a DTM with cells <=
  0.3 m; hazards with an exhaustive inventory and every hazard confirmed clear. fail needs the limit reached at every placement, or a
  hazard overlap confirmed with verified dimensions. Regional slope, storage quantisation and interpolation are never footprint evidence.
- Load or computation failures give `error` (never `fail`); a confirmed hazard failure stays `fail` even if terrain loading failed.
- Current candidates: slope and obstacles unknown at all 12 (2-5 m NAC DTMs); hardware overlap `possible` at all 12. Apollo 11 was
  `fail` until the step 11 wrap-up; its overlap rested on 3 x a 0.3 m position error of unknown statistic, so it is now `unknown`
  (`hazard-position-bound-unproven`, with what-if values). All 12 terrain conditions are `unknown`.

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

Visibility and events (steps 09-10): `sunAt` ~15 us, `earthAt` ~8 us. A 14-day mission (`missionStatistics`, three channels):
20-40 ms at a mid-latitude site, 135-200 ms at a polar site with a grazing Sun on a rugged skyline (6,000-11,000 evaluations).

Terrain (step 07): 9.5 MB published for 12 sites (0.4-1.05 MB each); loading all 12 in Chrome took 0.8 s from the dev server and
about 24 MB of JS heap. Building all sites takes ~40 s from the cache (~6 min uncached, ~0.5 GB RSS); one horizon cast ~0.4-0.5 s.

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
| Step 06 holdout (12 epochs, 7 new sites, transit pairs; budgets fixed first) | sub-solar 29.8", Sun/Earth from sites 29.8"/7.9", Moon centre 13.9 km, transit 7.7 s | as above, 60 s transit |
| Terrain horizon (step 07) | Synthetic geometry tests exact; candidate horizons partial (lower bounds), start distance not converged; see `docs/step-07` and `sources.md` | formal gate rejects partial |

## Sources

Every constant, dataset and texture used by the code is listed in `sources.md` at the repository root.

## Tests

`npx vitest run` runs all tests; `npx tsc -b` should print nothing.
