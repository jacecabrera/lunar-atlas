# Sources

Everything the simulation and the scene take from outside this repository.

## Ephemerides and orientation

| Used for | Source | Where in code |
|---|---|---|
| Sun and Moon positions (geocentric vectors) | Astronomy Engine 2.1.19 (`GeoVector`), https://github.com/cosinekitty/astronomy | `physics/ephemeris.ts`, `physics/moonFrame.ts` |
| Moon pole direction and prime meridian angle (RA, Dec, W) | Astronomy Engine `RotationAxis(Body.Moon)`, which implements the IAU WGCCRE cartographic elements: Archinal et al., "Report of the IAU Working Group on Cartographic Coordinates and Rotational Elements" (Celestial Mechanics and Dynamical Astronomy) | `physics/moonFrame.ts` |
| Earth rotation angle | Astronomy Engine `SiderealTime` (Greenwich apparent sidereal time). Precession since J2000 (~0.3 deg) is ignored | `physics/earthFrame.ts` |
| Moon-fixed frame (+X = lon 0, +Y = 90 E, +Z = north) | Same convention as the IAU Moon frame and JPL Horizons `MOON_ME` | `physics/moonFrame.ts` |
| Astronomical unit, 149,597,870.7 km | IAU 2012 Resolution B2 | `physics/coords.ts` |

## Physical constants

| Constant | Value | Source | Where |
|---|---|---|---|
| Moon radius | 1737.4 km | IAU WGCCRE (Archinal et al.); same as the Horizons target radius | `physics/siteSky.ts` |
| Earth equatorial radius | 6378.137 km | WGS-84 / IERS equatorial radius; also the Horizons center radius (IAU 2015 B3 nominal value is the rounded 6378.1 km) | `physics/siteSky.ts` |
| Sun radius | 695,700 km | IAU 2015 Resolution B3 nominal solar radius, https://www.iau.org/common/Uploaded%20files/IAUGA2015-Resolution-B3-recommended-nominal-conversion.pdf (arXiv:1510.07674) | `physics/siteSky.ts` |

The scene meshes use rounded radii (`MOON_R = 1.737`, `EARTH_R = 6.371`, in units of 1000 km). Earth uses its mean radius, because the mesh is a sphere. The site calculations use the constants above.

## Textures

- `public/textures/earth.jpg`: NASA Earth Observatory, *Blue Marble: Next Generation with Topography and Bathymetry*, January 2004, 5400x2700 (8 km/pixel), equirectangular, lon -180 at the left edge. Produced by Reto Stöckli, NASA Earth Observatory (NASA Goddard Space Flight Center). Credit "NASA Earth Observatory".
  https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-topography-bathymetry
- `public/textures/moon.jpg`: NASA Scientific Visualization Studio, CGI Moon Kit colour map (built from Lunar Reconnaissance Orbiter imagery), downsampled to 2048x1024 and resaved in Photoshop on 2025-12-02. Equirectangular, lon 0 at the centre. Credit "NASA's Scientific Visualization Studio". **TODO: add the SVS page URL and original file name.** The Moon Kit also provides a matching LOLA displacement map, which is not used yet.

## Validation data

The simulation is compared against JPL Horizons (https://ssd.jpl.nasa.gov/horizons/, DE441 ephemeris, Moon body-fixed frame `MOON_ME`).

- Checked: Moon orientation, sub-Earth and sub-solar selenographic lat/lon.
  - Request: target Moon (301), center Earth (399) geocentric, DE441, Moon pole/equator `MOON_ME` (east-longitude positive), target radii 1737.4 km, no refraction, 2026-11-13 00:00 to 2026-11-14 00:00 UT, 360 min step, quantities `ObsSub-LON/LAT` (sub-Earth) and `SunSub-LON/LAT` (sub-solar). Retrieved 2026-11-13 22:23 UT; EOP file eop.261113.p270209.
  - Horizons values (deg), compared in `physics/horizonsValidation.test.ts`:

    | UT | ObsSub-LON | ObsSub-LAT | SunSub-LON | SunSub-LAT |
    |---|---|---|---|---|
    | 2026-11-13 00:00 | 0.129851 | 5.312565 | 138.809060 | -1.556378 |
    | 2026-11-13 06:00 | 359.798767 | 5.104871 | 135.760760 | -1.556724 |
    | 2026-11-13 12:00 | 359.462240 | 4.883706 | 132.712752 | -1.556987 |
    | 2026-11-13 18:00 | 359.121154 | 4.649652 | 129.665047 | -1.557170 |
    | 2026-11-14 00:00 | 358.776460 | 4.403300 | 126.617658 | -1.557279 |

  - Result: sub-Earth longitude differs by 15 to 18 arcsec (ours is lower), latitude by under 1 arcsec; sub-solar longitude by 15 arcsec (ours is higher), latitude by 3 to 4 arcsec. The worst case is 0.005 deg. The simulation uses geometric vectors, and Horizons applies light-time and aberration corrections, so a difference of about 20 arcsec is expected.
  - Horizons' Moon geophysical data in the same output confirms the IAU radius 1737.4 km (volumetric mean 1737.53 km, gravity radius 1738.0 km).
- Pending: observer-on-the-Moon elevation and azimuth. Request an observer table with the Moon as the center body and a site coordinate on the Moon, then compare against `skyAt()` at the same UTC times.
- Earth orientation: checked only against the sub-solar longitude and declination, to a few degrees (see `physics/earthFrame.test.ts`).

## Terrain data

| Product | Resolution | Coverage | Source | Where |
|---|---|---|---|---|
| LDEM_4 | 4 pixels/deg (~7.6 km) | Global, cylindrical | LRO LOLA GDR, PDS Geosciences Node, https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/ | `public/data/lola/ldem_4.bin` |
| LDEM_16 | 16 pixels/deg (~1.9 km) | Global, cylindrical | Same | Not shipped; build with `node tools/buildDem.mjs 16` |

The DEM files are 16-bit signed integers, metres above the 1737.4 km reference sphere, little-endian.
Row 0 is +90° latitude, column 0 is 0° east longitude, pixel centres at half-pixel offsets.
`tools/buildDem.mjs` downloads the float32 source from PDS and converts it.

### Terrain limitations

- Slope is measured over a baseline no smaller than one grid pixel. At 4 pixels/deg (~7.6 km), slopes are heavily smoothed. A "landable" slope from this grid is a regional average, not a safety assessment at lander scale (tens of metres).
- The horizon profile casts 360 rays out to a default range of 200 km, sampling at half-pixel intervals. Near terrain smaller than a pixel is not resolved. A nearby crater wall within one pixel is invisible.
- The site is placed at the DEM ground height. There is no separate site-elevation input.
- Polar stereographic LOLA products (higher resolution, 20–80 m) are not yet supported. They would need a separate loader and tiled storage.

## Power viability simulation

The power simulation (`src/sim/power.ts`) assesses whether a spacecraft can sustain its electrical requirements throughout a specified stay at a lunar landing site. It is an intentionally idealised model. The assumptions and limitations below must be read alongside any results.

### Assumptions

1. **Binary solar generation model.** Whenever any part of the Sun's disc is above the local horizon (`sunUp` from `skyAt`), the solar panel produces its maximum rated electrical output (`maxSolarKw`). When the Sun is entirely below the horizon, output is zero.
2. **Perfect Sun tracking.** Solar panels continuously face directly toward the Sun, with no orientation restrictions, tracking delays or gimbal limits.
3. **100 % conversion efficiency.** The specified maximum solar recharge rate is the maximum electrical output. Conversion losses, panel degradation, dust accumulation and temperature-related efficiency changes are excluded.
4. **No partial-illumination scaling.** Output is not proportionally reduced when only part of the panel surface is illuminated, nor when the Sun elevation is low. Any sunlight = full output.
5. **Sun elevation determines availability only.** Elevation contributes to whether the Sun is above the horizon. It does not independently attenuate output.
6. **Normal and essential power modes.** Normal vessel power consumption represents the total electrical load during standard operation. Essential-system consumption is a separate, reduced operating configuration for critical functions. They are not additive.
7. **Time-dependent consumption.** Vessel power consumption can vary during the mission via a `PowerSchedule`. Where no schedule is provided, the constant normal load is used.
8. **Battery limits enforced.** Battery charge is clamped to `[0, maxCapacity]`. Charge below the user-specified minimum reserve is recorded as a violation. Any energy demand that cannot be met is recorded as deficit.
9. **No degradation in v1.** Battery degradation, cycle-life limits, charge/discharge rate limits and other electrical component wear are excluded from the initial implementation. The architecture includes a `degradation` callback for future use.
10. **Provisional defaults.** All placeholder default values (`DEFAULT_POWER_CONFIG`) are arbitrary and are not based on researched spacecraft specifications.

### Environmental model limitations

- **Terrain obstruction.** On a smooth sphere (no `Site.horizon`), the horizon is geometric. At polar sites this overestimates sunlight. With a LOLA horizon profile attached, the simulation respects terrain, but only at the DEM resolution (see "Terrain limitations" above).
- **Partial disc illumination detection.** The existing model reports whether any part of the Sun's disc clears the horizon. It does not report what fraction of the disc or of the panel surface is illuminated. The binary generation model treats any visibility as full output.
- **No eclipses.** Lunar eclipses (Earth blocking the Sun) are not modelled. During an eclipse the simulation will incorrectly show the Sun as up.
- **No reflected light.** Earthshine and secondary illumination are not considered.

### Calculation method

The simulation steps through the mission at a configurable interval (default 5 minutes). At each step:

1. Sun visibility is looked up from the pre-computed sun-up intervals (`windows('sun', ...)`).
2. Solar generation is `maxSolarKw` if sun is up, else 0.
3. Current load is read from the schedule or defaults to `normalLoadKw`.
4. Net power = solar − load.
5. Battery charge is updated: `E_next = min(maxCapacity, E_current + net × Δt)`.
6. If charge would go negative, it is set to 0 and the shortfall is added to the cumulative deficit.
7. If charge < minReserve, the breach is recorded.

A site is classified as viable only if there is no deficit, no depletion and no reserve breach over the entire mission.

### Data sources

No external spacecraft specifications are used. All parameters are user-supplied or use the provisional placeholder defaults listed in `DEFAULT_POWER_CONFIG`. No scientific sources are cited for these defaults because they are not intended to represent any real vehicle.

## Not yet included

- High-resolution polar terrain (LDEM_80S_20M etc.). The Moon is a smooth sphere unless a `Horizon` is supplied. Candidate source for real horizon profiles: LRO LOLA elevation data (NASA PDS Geosciences Node).
