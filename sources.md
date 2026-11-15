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

## Not yet included

- High-resolution polar terrain (LDEM_80S_20M etc.). The Moon is a smooth sphere unless a `Horizon` is supplied. Candidate source for real horizon profiles: LRO LOLA elevation data (NASA PDS Geosciences Node).
