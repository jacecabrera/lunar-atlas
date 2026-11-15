# Sources

The master register of everything the simulation, the scene and the configuration files take from outside this repository.
Detailed investigations stay in the step documents under `docs/` and refer to the IDs below; the JSON files in `src/data/` carry
the same IDs in their `sourceIds` and `assumptionIds` fields (a test checks that every ID used there exists here).

## How to read the register

**ID prefixes.** `SRC-` external source. `ASM-` project assumption or policy (defined in this file, not an agency rule). `REQ-` project requirement document.

**Verification status** (what was actually done in this project; dates are local, 2026-11-14 unless stated):

| Status | Meaning |
|---|---|
| read-original | The original document, label or file was opened and read |
| metadata-only | Only an abstract, catalogue entry or metadata was read |
| agent-reported | Retrieved by a research helper and not re-read by the maintainer |
| not-verified | Cited by a project document but never opened |
| access-failed | An attempt failed (error page, HTTP 403, login wall). This says nothing about whether the data exist |
| not-applicable | A project-defined value with no external source |

**Value kinds.** *Source value*: stated by the source. *Derived*: computed from source values. *Project assumption*: chosen by this project. Unknown stays unknown and is never filled with a number.

## Source register

| ID | Title and publisher | URL | Product / version | Verification | Supports | Scope and limits |
|---|---|---|---|---|---|---|
| `SRC-NSSDCA-ARTIFACTS` | Lunar Artifact Impacts and Landing Sites list, NASA NSSDCA | https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_artifact_impacts.html | "Last Updated: 13 August 2025" | read-original | Catalog `candidates[].coordinate` (12 points) | DE421 mean Earth/polar axis frame; "precision of knowledge of location is reflected in the precision of the coordinates"; 0.001 degree is about 30 m. The row for "Vikram" (70.8810 S, 22.7840 E) is the 2019 Chandrayaan-2 impact, not Chandrayaan-3 |
| `SRC-NSSDCA-A11` | Apollo 11 spacecraft page (1969-059C), NASA NSSDCA | https://nssdc.gsfc.nasa.gov/nmc/spacecraft/display.action?id=1969-059C | NMC master catalog | read-original | Catalog Apollo 11 `hardware.dimensionsM` | Descent stage 4.2 m across, 1.7 m thick, footpad span 9.4 m, 1.5 m ground clearance. Applicability to Apollo 12-17 not checked |
| `SRC-NSSDCA-S7` | Surveyor 7 spacecraft page (1968-001A), NASA NSSDCA | https://nssdc.gsfc.nasa.gov/nmc/spacecraft/display.action?id=1968-001A | NMC master catalog | read-original | Catalog Surveyor 7 `hardware.dimensionsM` | About 3 m tall; footpads extend 4.3 m from the centre |
| `SRC-NSSDCA-NMC-FAILED` | NSSDCA pages 1970-072A, 2018-103A, 2013-070A, 2020-087A, 2023-098A | https://nssdc.gsfc.nasa.gov/nmc/ | n/a | access-failed | Missing hardware dimensions of Luna 16, Chang'e 3/4/5, Chandrayaan-3 | Pages returned "An error has occurred" for the research helper; other sources for these dimensions were not found |
| `SRC-LROC-ANTHRO` | LROC Anthropogenic Objects shapefile, LROC / Arizona State University (PDS) | https://data.lroc.im-ldi.com/lroc/view_rdr/SHAPEFILE_ANTHROPOGENIC_OBJECTS | `ANTHROPOGENIC_OBJECTS_180.ZIP`, README "Last updated: 2026-08-14", SHA-256 f0145e0b8871053f3358c599d356a5af05db70e4da2fe8c91264e84b98e4408b | read-original | Catalog `alternateCoordinates`, `hardware.nearbyObjects` | 71 points; "IAU Moon 2000 Geographic Coordinate System" per README; uncertainty column UNCERTAIN in metres with no stated statistic |
| `SRC-WAGNER2017` | Wagner et al., Coordinates of anthropogenic features on the Moon, Icarus 283, 92-103 (2017), doi:10.1016/j.icarus.2016.05.011 | https://doi.org/10.1016/j.icarus.2016.05.011 | Published online 2016 | metadata-only | Method behind `SRC-LROC-ANTHRO` | Cited by the shapefile README; the paper was not opened |
| `SRC-LROC-COORD-PDF-2016` | Coordinates of Lunar Anthropogenic Targets (2016), LROC | https://lroc.im-ldi.com/data/support/downloads/2016_LROC_Coordinates_of_Human_Features.pdf | 28 July 2016 | agent-reported | Context for `SRC-LROC-ANTHRO` | States a mean Earth/polar axis frame and per-row uncertainties (research helper, not re-read) |
| `SRC-LROC-PAGES` | LROC image and post pages (images/141, 379, 534, 751, 1087, 1090, 1172, 1314; posts/29) | https://lroc.im-ldi.com/ | n/a | agent-reported | Catalog `measuredDimensionsM` (Apollo 14), hardware notes, alternate text coordinates | Not re-read |
| `SRC-LROC-NAC-DTM-CATALOG` | LROC NAC DTM footprint shapefile, LROC (PDS) | https://data.lroc.im-ldi.com/lroc/view_rdr/SHAPEFILE_NAC_DTMS | `NAC_DTMS_180.ZIP`, 662 records, released through 2026-09-15, SHA-256 3e7e865d22a1a5f65b6647cb1d23f3b6d10f8dc658228b3f774e6d61f75396e0 | read-original | Catalog `terrain.localDtms` (posting, errors, offsets, versions) | Moon_2000 geographic; `relat_le` is 90 % vertical precision from SOCET SET; coverage here means inside the footprint polygon |
| `SRC-LROC-NAC-DTM-PDS` | LROC NAC DTM products, labels, READMEs and confidence maps, LROC / PDS | https://data.lroc.im-ldi.com/lroc/view_rdr/NAC_DTM_APOLLO11 (pattern `view_rdr/NAC_DTM_<SITE>`) | 17 DTMs at the 12 points, versions per DTM | read-original | Catalog `terrain.localDtms[].pointSample`; step 07 near field (`public/data/terrain/v1/<site>/near.i16`, `near-conf.u8`) via `tools/buildSiteTerrain.mjs` | Step 07 read the PDS3 labels of all 17 DTMs and cropped 12 (one per site, selection rule in `docs/step-07-terrain-and-horizon.md`). Label fixes bound to these products: `upperleft_corner_x` sign reconciled against the west bound; VIKRAMSITE1 polar latitude read as the true-scale latitude. Window of 21 x 21 pixels read per point by `tools/nacDtmPointSample.mjs`. The confidence-code table was read only in the Apollo 11 README. Labels read: Apollo 11 and Chandrayaan-3 in full, the others through the sampling script. Old `pds.lroc.im-ldi.com` paths redirect to `pds.mcp.nasa.gov`, which has no directory listing |
| `SRC-HENRIKSEN2017` | Henriksen et al., Extracting accurate and precise topography from LROC narrow angle camera stereo observations, Icarus 283, 122-137 (2017), doi:10.1016/j.icarus.2016.05.012 | https://doi.org/10.1016/j.icarus.2016.05.012 | Published online 2016; the DTM READMEs write 2016, the shapefile README writes 2017: same paper | metadata-only | Catalog `terrainProducts[nac-dtm]` accuracy statements | Abstract (ASU repository): absolute accuracy about 10 m horizontal and 1 m vertical, relative precision better than the 2-5 m DTM pixel scale. A 2016 ISPRS conference paper by the same group exists and was not used (PDF text could not be extracted) |
| `SRC-LOLA-GDR-CYL` | LOLA Gridded Data Records, cylindrical products, NASA PDS Geosciences Node | https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/ | `LDEM_512_00N_45N_000_090_FLOAT` label read: V3.0, created 2017-09-15 (other tiles not opened); `LDEM_4` | read-original | Catalog `terrainProducts[lola-ldem-512, ldem-4]`; `tools/buildDem.mjs` | Frame "MEAN EARTH/POLAR AXIS OF DE421"; surface-fitting interpolation between tracks; accuracy not in the label |
| `SRC-LOLA-GDR-POLAR` | LOLA Gridded Data Records, polar products, NASA PDS Geosciences Node | https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/ | `LDEM_60S_60M` V2.1, created 2017-06-15 | read-original | Catalog `terrainProducts[lola-ldem-60s-60m]`; step 07 Chandrayaan-3 mid (`LDEM_60S_60M`) and far (`LDEM_60S_240M`, V2.1) bands | 60 m / 240 m, polar stereographic, tracks interpolated; accuracy not in the label. Axis signs (x east-positive, y north-negative in image rows) were not stated unambiguously and were fixed by comparison with LDEM_4 (r = 0.994 for the chosen variant, all others negative) |
| `SRC-SLDEM2015-PDS` | SLDEM2015 tiles and data-quality map, NASA PDS Geosciences Node (LOLA team) | https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/sldem2015/ | V2.0, created 2015-09-15; `sldem2015_data_quality_float` read | read-original | Catalog `terrainProducts[sldem2015]`, `regionalProducts[].qualityResidualRmsM`; step 07 mid band (512 ppd tiles, FLOAT) and far band (`SLDEM2015_128_60S_60N_000_360_FLOAT`) for 11 candidates | Read by HTTP range requests (no full download); each tile label is checked against the virtual global grid before use. Latitudes within +/-60 degrees only; quality map is 1 pixel/degree RMS residual between LOLA and the TC tile |
| `SRC-SLDEM2015-BARKER` | Barker et al., A new lunar digital elevation model from LOLA and SELENE Terrain Camera (SLDEM2015), NASA NTRS 20170002253; PGDA product 54 | https://pgda.gsfc.nasa.gov/products/54 | n/a | agent-reported | Typical vertical accuracy about 3-4 m; TC effective resolution about 60-100 m | Statistic not stated; not re-read |
| `SRC-SLDEM2013-DARTS` | SELENE TC SLDEM2013 (SLN-L-TC-5-SLDEM2013-V1.0), JAXA DARTS | https://data.darts.isas.jaxa.jp/pub/pds3/sln-l-tc-5-sldem2013-v1.0/ | Tile `DTM_MAP_01_S69E032S70E033SC` label read, product version "01" | read-original | Catalog `terrainProducts[sldem2013]` | Label read for one tile (Chandrayaan-3); the accuracy line "nearly 10 meters or better" is agent-reported; mean Earth vs principal axis not stated |
| `SRC-PGDA-78` | High-Resolution LOLA Topography for Lunar South Pole Sites (product 78), NASA PGDA | https://pgda.gsfc.nasa.gov/products/78 | No version; updates 2021-04-26 to 2022-08-15 | read-original | Catalog `terrainProducts[pgda-78]` | First 100,000 of 286,283 characters read; no latitude bounds found, so coverage of -69.37 is unverified |
| `SRC-WATKINS-BOULDERS` | Lunar Boulder Distribution Database, R. Watkins, Mendeley Data | https://data.mendeley.com/datasets/9z52fv8ghd/1 | Version 1, 2019-09-19, doi:10.17632/9z52fv8ghd.1 | read-original | Boulder detectability: "LROC NAC images allow for boulders ~1-2m in size and larger to be identified and measured" at ~0.5-2 m/pixel | Manual identification scale, not a detection-probability curve |
| `SRC-ISRO-LPSC2023-1037` | ISRO landing-site abstract, LPSC 2023 #1037 | https://www.hou.usra.edu/meetings/lpsc2023/pdf/1037.pdf | n/a | read-original | Catalog `terrainProducts[ohrc-dem-isro]` | Text extracted from the PDF: "DEM at 0.32m grid interval having a height resolution of 0.05m"; criterion "Boulders less than 0.32 meter". Height resolution is not an accuracy |
| `SRC-ISRO-LPSC2021-1396` | ISRO OHRC DEM abstract, LPSC 2021 #1396 | https://www.hou.usra.edu/meetings/lpsc2021/pdf/1396.pdf | n/a | agent-reported | Catalog `terrainProducts[ohrc-dem-isro]` | 0.28 m pixel, 0.1 m vertical resolution (research helper) |
| `SRC-OHRC-INDEP-ARXIV` | Independent OHRC DEM of the Chandrayaan-3 site, arXiv 2602.14993v1; Zenodo 10.5281/zenodo.18634148 | https://arxiv.org/abs/2602.14993 | Preprint | agent-reported | Catalog `terrainProducts[ohrc-dem-independent]` | DEM not yet released (Zenodo record held only a PDF) |
| `SRC-CE-LANDING-DEM-PAPERS` | Landing-site mapping papers for Chang'e 3/4/5 (Liu et al. 2014; Di et al. 2019; Di et al. 2025; Bo et al. 2022) | https://isprs-archives.copernicus.org/ | ISPRS Archives | agent-reported | Catalog `terrainProducts[ce-landing-site-dems]`, Chang'e 5 alternate coordinates | No data-availability statement or download found; this is not evidence that the data cannot be requested |
| `SRC-LIU2019-CE4` | Liu et al. 2019, Chang'e-4 landing site analysis, Nature Communications (PMC6760200) | https://pmc.ncbi.nlm.nih.gov/articles/PMC6760200/ | n/a | agent-reported | Chang'e 4 alternate coordinate and crater distance | Not re-read |
| `SRC-CE4-RELAY` | Queqiao relay reports (english.spacechina.com 2018; EurekAlert 2021) | https://www.eurekalert.org/news-releases/593641 | n/a | agent-reported | Qualitative note: Chang'e 4 needs a relay | No visibility window was computed |
| `SRC-CLPDS` | China Lunar and Planetary Data Release System (Chang'e-2 DEM), CLEP/NAOC | https://moon.bao.ac.cn/ | CE2TMap2015 | agent-reported | Catalog `terrainProducts[ce2-ccd-dem]` | Registration required; catalogue could not be browsed (JavaScript portal); tile coverage unverified |
| `SRC-PRADAN` | PRADAN Chandrayaan-2 data portal, ISRO / ISSDC | https://pradan.issdc.gov.in/ch2/ | n/a | agent-reported | Catalog `terrainProducts[ohrc-dem-isro, tmc2-dtm]` | Login required; no DEM product listed on the public page |
| `SRC-ISRO-CH3-DETAILS` | Chandrayaan-3 mission details, ISRO | https://www.isro.gov.in/Chandrayaan3_Details.html | n/a | agent-reported | Prime landing area centre (planned target, not touchdown) | Not re-read |
| `SRC-TREK-API` | Moon Trek tile API, NASA JPL | https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=moon | n/a | not-verified | Catalog `terrainProducts[moon-trek-tiles]` | Described in the requirements as image tiles; not numeric DEM; not used |
| `SRC-PROJECT-LDEM4` | The LDEM_4 file shipped with the app (`public/data/lola/ldem_4.bin`, `.json`) | n/a | PDS version at conversion not recorded | read-original | Catalog `terrainProducts[ldem-4]` | Converted by `tools/buildDem.mjs` from the PDS float image |
| `SRC-ILN-NASA` | NASA ILN concept design report, Case 1 (solar plus battery), NASA NTRS TM-20210025878 (the acronym is used as in the project reference file and is not expanded here) | https://ntrs.nasa.gov/api/citations/20210025878/downloads/TM-20210025878.pdf | Printed pages 37 (Sections 5.4.4-5.4.5), 59-60 (Figures 8.3-8.4) | read-original | Defaults `device.pvEfficiency`, `panelCount`, `panelWidthM`, `panelHeightM`, `panelTotalAreaM2`, `panelAzimuthsDeg`, `pvArrayNominalW`, `baseLoadW`, `commLoadW` | Re-read 2026-11-15 from the NTRS PDF (text extracted locally; no PDF renderer). Figure 8.4: "Two fixed panels (east/west)", "Conversion efficiency is 30 percent", "Solar arrays: two 54-by-54-cm"; Figure 8.3: "Power: 100 W GaAs solar arrays (fixed)"; "23 W during the night"; "5 W DC S-band communications (average during sunlight periods)". Discrepancies kept visible: Section 5.4.4 gives a Case 1 baseline efficiency of 28 percent, and Section 5.4.5 says the analysis "assumed two fixed arrays, tilted at 45 deg" (this project keeps the v0.7 value of 90 deg). Case 2 (nuclear) parameters are not used |
| `SRC-NASA-MOON-FACTSHEET` | Moon Fact Sheet, NASA NSSDC | https://nssdc.gsfc.nasa.gov/planetary/factsheet/moonfact.html | n/a | not-verified | Defaults `model.solarIrradianceWm2` (1361 W/m2 at 1 AU), `model.solarReferenceDistanceAu`; semi-major axis 384,400 km behind `mission.transitSpeedKmPerS` | Cited by the project reference file; not opened here |
| `SRC-NASA-APOLLO-JOURNEY` | Journey to the Moon, NASA Science | https://science.nasa.gov/resource/journey-to-the-moon/ | n/a | not-verified | About three days Earth-Moon travel behind `mission.transitSpeedKmPerS` | Cited by the project reference file; not opened here |
| `SRC-JPL-SURVEYOR1` | Surveyor I mission, NASA JPL | https://www.jpl.nasa.gov/news/surveyor-i-mission/ | n/a | not-verified | Context only (63 h 36 min flight time) | Not used by a parameter |
| `SRC-NASA-ALHAT` | NASA ALHAT hazard detection, NASA NTRS 20110003001 | https://ntrs.nasa.gov/citations/20110003001 | n/a | not-verified | Defaults `terrain.slopeLimitDeg`, `terrain.obstacleLimitM` (scale reference only) | Cited by the project reference file; not opened here. The thresholds are project screening values, not an ALHAT or NASA certification |
| `SRC-NASA-SITE-SELECTION` | Lunar Site Selection white paper, NASA 2024 architecture workshop | https://www.nasa.gov/wp-content/uploads/2024/02/15-2024-architecture-workshop-white-paper-lunar-site-selection.pdf | n/a | not-verified | Context: legacy hardware can obstruct later landings | Not opened here |
| `SRC-ASTRONOMY-ENGINE` | Astronomy Engine 2.1.19 (MIT licence), Don Cross | https://github.com/cosinekitty/astronomy (installed copy `node_modules/astronomy-engine/astronomy.js`) | 2.1.19 | read-original | `physics/ephemeris.ts`, `moonFrame.ts`, `earthFrame.ts`, `timeScale.ts` | Step 06 read the installed source: `GeoVector(Moon)` returns `GeoMoon` and ignores both light-time and aberration; `GeoVector(Sun, false)` is the geometric Earth -> Sun vector (heliocentric, Sun at origin); `GeoMoon` is based on the 1954 Improved Lunar Ephemeris (Montenbruck and Pfleger); `RotationAxis(Moon)` uses WGCCRE 2009 Table 2 with TT; `ObserverVector` uses geodetic latitude on a 6378.1366 km ellipsoid (b/a = 0.996647180302104), GAST and IAU 2000B nutation; UT1 is taken as UTC; EQJ has no ICRS frame bias. Measured accuracy: see `SRC-HORIZONS-API` |
| `SRC-IAU-WGCCRE` | IAU WGCCRE reports (Archinal et al.): lunar rotation elements (2009 report, Table 2) and radius 1737.4 km | Not recorded in the original notes; Astronomy Engine cites https://astropedia.astrogeology.usgs.gov (WGCCRE 2009 reprint) | 2009 elements for the Moon | metadata-only | `physics/moonFrame.ts` (via `RotationAxis`), `physics/siteSky.ts` | The report was not opened; the elements were read in the library source. NAIF (`SRC-NAIF-MOON-FK`) states the 2009 IAU lunar frame differs from DE440 mean Earth by a time-dependent ~0.0051 deg amplitude (mean ~0.0024 deg) over 2000-2040 |
| `SRC-IAU-2012-B2` | IAU 2012 Resolution B2 (astronomical unit) | Not recorded in the original notes | n/a | not-verified | `physics/coords.ts` (`AU_KM`) | As cited in the original project notes |
| `SRC-IAU-2015-B3` | IAU 2015 Resolution B3 (nominal solar radius) | https://www.iau.org/common/Uploaded%20files/IAUGA2015-Resolution-B3-recommended-nominal-conversion.pdf | arXiv:1510.07674 | not-verified | `physics/siteSky.ts` (`SUN_R_KM`) | As cited in the original project notes |
| `SRC-NASA-BLUE-MARBLE` | Blue Marble: Next Generation with Topography and Bathymetry, NASA Earth Observatory | https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-topography-bathymetry | January 2004 | not-verified | `public/textures/earth.jpg` | As cited in the original project notes |
| `SRC-NASA-SVS-MOONKIT` | CGI Moon Kit colour map, NASA Scientific Visualization Studio | https://svs.gsfc.nasa.gov/ | Page URL and original file name still missing | not-verified | `public/textures/moon.jpg` | TODO: add the SVS page URL and file name |
| `SRC-JPL-HORIZONS` | JPL Horizons, first validation sample (DE441, MOON_ME) | https://ssd.jpl.nasa.gov/horizons/ | Retrieved 2026-11-13 | read-original | `physics/horizonsValidation.test.ts` | 5 epochs on one day, sub-Earth and sub-solar points; kept as a historical regression. Superseded as evidence by `SRC-HORIZONS-API` |
| `SRC-HORIZONS-API` | JPL Horizons API reference set for step 06 | https://ssd.jpl.nasa.gov/api/horizons.api (API version 1.2; documentation https://ssd-api.jpl.nasa.gov/doc/horizons.html) | Retrieved 2026-11-15 (local 2026-11-14); DE441; EOP file eop.261113.p270209 (data to 2026-11-13, predictions to 2027-02-08) | read-original | `src/physics/reference/horizons-step06.json`, `physics/horizonsReference.test.ts`, generated by `tools/fetchHorizonsReference.mjs` | 27 fixed epochs 2016-11-14 to 2036-11-14 (geocentric geometric ICRF vectors of Moon and Sun; sub-Earth and sub-solar points in MOON_ME); 14 lunar sites (12 candidates, 89.5 S, 180 E) at 5 epochs plus near-horizon rows from hourly scans (apparent az/el, light-time range; site frame "MEAN_ME (high precision)", radius 1737.4 km); 6 Earth sites (ITRF93 geodetic, WGS-84 radii) at 5 epochs. Future epochs use predicted or constant Earth orientation and the last known leap second ("UT~") |
| `SRC-HORIZONS-MANUAL` | Horizons System Manual, JPL SSD | https://ssd.jpl.nasa.gov/horizons/manual.html | Retrieved 2026-11-15 | read-original | Comparison conventions in `physics/horizonsReference.test.ts` | Lunar frame "Lunar mean Earth (DE421)", realized from the DE440 principal-axis frame by a fixed rotation; high-precision lunar pole model only for 1550-2650; quantity 14 accounts for down-leg light-time; quantity 15 for Sun -> target and target -> observer light-time; quantity 4 is apparent (light-time, deflection, aberration, precession, nutation); Earth sites relative to ITRF93 / WGS-84 ellipsoid |
| `SRC-NAIF-MOON-FK` | NAIF lunar frame kernel `moon_de440_250416.tf` | https://naif.jpl.nasa.gov/pub/naif/generic_kernels/fk/satellites/moon_de440_250416.tf | 2025-04-16 version (text comments read; binary PCK not used) | read-original | Frame relations in `docs/step-06-frames-and-ephemeris.md` | DE440 ME (aligned with DE421 ME) vs DE421 ME: at most 0.53 m over 2000-2040; DE440 ME vs PA: constant ~0.02886 deg (~875 m), not an IAU-to-ME correction; IAU_MOON (2009) vs DE440 ME: amplitude ~0.0051 deg, mean ~0.00239 deg over 2000-2040; ICRF vs J2000 frame offset ~18 mas (pole), ~78 mas (equinox) |
| `SRC-IERS-LEAP-SECONDS` | IERS Leap_Second.dat (TAI - UTC) | https://hpiers.obspm.fr/iers/bul/bulc/Leap_Second.dat | "Updated through IERS Bulletin 72 issued in July 2026"; expires 28 June 2027 | read-original | `physics/timeScale.ts` (`LEAP_SECONDS`) | TAI - UTC = 37 s since 2017-01-01. Values after the expiry date are an assumption (held constant) |
| `REQ-V07` | Lunar Landing Site Navigator requirements baseline v0.7 and the candidate and machine reference v0.1 (project documents) | Local planning documents, not part of the repository | v0.7 | read-original | Defaults that were confirmed by the user: scoring weights, count limits, clock and Clear settings | Used by name only; the repository code and data never read these files |

## Project assumptions and policies

These are choices made by this project. They are not specifications of any agency. Each is defined here and in the `note` of the parameter that uses it in `src/data/lunar-mission-defaults-v0.1.json`.

| ID | Assumption or policy | Used by (defaults file keys) |
|---|---|---|
| `ASM-PANEL-TILT` | Panels are vertical (90 degrees from horizontal), as confirmed in v0.7. The ILN Case 1 analysis assumed 45 degrees (Section 5.4.5); the project value is a deliberate choice, not the source value | `device.panelTiltDeg` |
| `ASM-PV-LIMIT` | The nominal 100 W array power is used as the controller output cap. The real hardware limit is not known | `device.pvOutputLimitW` |
| `ASM-BASE-LOAD-CONTINUOUS` | The approximately 23 W night-time load applies for the whole mission | `device.baseLoadContinuous` |
| `ASM-COMM-ALWAYS-ON` | The 5 W communication load is on during every geometric Earth-visibility interval; no data rate or minimum downlink is defined | `device.commAlwaysOnWhenEarthVisible` |
| `ASM-BUS-EFFICIENCY` | 90 % supply efficiency from the common bus to the device input, applied once | `device.busEfficiency` |
| `ASM-BATTERY` | Battery capacity and initial stored energy of 12,000 Wh (starts full) at the internal storage terminal; not derived from battery mass | `device.batteryCapacityWh`, `device.initialEnergyWh` |
| `ASM-RESERVE-POLICY` | The reserve is 20 % of capacity; the Wh value is derived, not stored | `device.reserveFraction`, `device.reserveWh` (derived) |
| `ASM-BATTERY-EFFICIENCY` | Charge and discharge efficiency of 95 % each, independent of other efficiencies | `device.chargeEfficiency`, `device.dischargeEfficiency` |
| `ASM-BUS-LIMITS` | Bus-side battery charge and discharge power limits of 100 W each | `device.chargeLimitW`, `device.dischargeLimitW` |
| `ASM-KLOSS` | k_loss = 1: dust, temperature and ageing losses are not modelled (not a claim that they are zero) | `model.lossFactor` |
| `ASM-TRANSIT-SPEED` | 1.5 km/s effective transit speed for a simplified distance-over-time estimate; not a measured trajectory speed | `mission.transitSpeedKmPerS` |
| `ASM-FOOTPRINT` | 3 m diameter local terrain footprint; not a lander dimension or dispersion ellipse | `terrain.footprintDiameterM` |
| `ASM-TERRAIN-THRESHOLDS` | Exclude slopes at or above 5 degrees and obstacles at or above 0.3 m; a project screening rule, not a universal landing certification | `terrain.slopeLimitDeg`, `terrain.obstacleLimitM` |
| `ASM-EARTH-GEOMETRY` | Earth is visible when the disc centre is strictly above max(terrain horizon, minimum elevation, default 0 degrees); no relay, antenna or link budget. Implemented in step 09 (`visibilityModel().earthAt`, `bodyMargin`) | `communication.earthMinElevationDeg` |
| `ASM-SCORE-WEIGHTS` | Default weights 0.50 / 0.30 / 0.20 (user-confirmed in v0.7), normalised before use; no minimum total score | `scoring.*` |
| `ASM-COUNT-LIMITS` | Up to 3 recommendations and 9 custom sites (user-confirmed in v0.7) | `limits.*` |
| `ASM-LAUNCH-HEIGHT` | Launch sites sit 0 m above the reference ellipsoid unless a height is given; height is not a main input and this is not the elevation of a real site | `src/sim/frames.ts` (`DEFAULT_LAUNCH_HEIGHT_M`) |
| `ASM-NO-FUTURE-LEAP-SECONDS` | No leap second after the IERS table's expiry (TAI - UTC held at 37 s), as Horizons does for future UTC | `physics/timeScale.ts` |
| `ASM-UT1-EQUALS-UTC` | Earth rotation uses UTC in place of UT1 (|UT1 - UTC| < 0.9 s, up to ~0.4 km at the equator) | `physics/earthFrame.ts` (Astronomy Engine) |
| `ASM-OBSERVER-HEIGHT` | The observer (horizon eye, sky direction, geocentric endpoint) sits at the site's terrain elevation plus 0 m. Lander or antenna height is not modelled; a horizon for another height is reported as not precomputed, never reused | `src/sim/siteTerrain.ts`, `tools/buildSiteTerrain.mjs` (`settings.observerHeightM`) |
| `ASM-SITE-ELEVATION-POLICY` | Site elevation = NAC DTM bilinear value at the catalogue coordinate when all four neighbours have data (quality from the nearest confidence code), else the regional grid value (quality `regional-fallback`), else unavailable. Suspicious codes and unconfirmed legends are kept and labelled, never replaced | `manifest.siteElevation`, `SiteTerrain.elevation` |
| `ASM-HORIZON-PARAMETERS` | Horizon cast: 0.5 deg azimuth step, half-pixel ray step, 20 m to 200 km, bands near 0-1 km (NAC), mid 1-30 km, far 30-200 km; a coarser product may fill a gap only from 5 of its pixels away; gaps longer than 3 NAC posts make the azimuth a lower bound. Chosen for this project and checked by convergence runs, not taken from a source | `tools/buildSiteTerrain.mjs` (`SETTINGS`) |
| `ASM-NAC-SELECTION` | Where several NAC DTMs cover a site: gates (valid data at the site; confidence codes within the README table; horizontal LOLA offset <= 10 m), relaxed in reverse order only if none passes; rank by relative linear error, LOLA RMS, posting, product ID | `tools/buildSiteTerrain.mjs` (`selectNac`), `manifest.nacSelection` |
| `ASM-HORIZON-CONVERGENCE` | A formal horizon must be converged: halving the azimuth step (0.5 -> 0.25 deg) and the ray step (0.5 -> 0.25 pixel), shortening the range to 150 km and moving the first sample from 20 m to 10 m may each change no azimuth complete in both runs by more than 0.05 deg. Project tolerance (about a fifth of the solar radius); all 12 candidates currently exceed it | `tools/buildSiteTerrain.mjs` (`convergenceToleranceDeg`), `requireHorizon` |
| `ASM-UNKNOWN-UNCERTAINTY-FACTOR` | Sensitivity only (revised in the step 11 wrap-up): a stated uncertainty whose statistic is unknown never supports pass or fail; 3 x the stated value is reported as a labelled what-if, not as a maximum, a 3-sigma level or any confidence level. A stated 0 of unknown meaning has no what-if value either | `src/sim/footprint.ts` (`FOOTPRINT_POLICY.sensitivityFactor`, `sensitivityBoundM`) |
| `ASM-FOOTPRINT-SAMPLING` | A footprint maximum slope needs at least 2 resolution cells across the footprint diameter (1.5 m cells for 3 m); slope is taken over a baseline of one resolution cell, never shorter | `src/sim/footprint.ts` (`minCellsAcrossFootprint`) |
| `ASM-OBSTACLE-RESOLUTION` | An obstacle of height h is assumed to be no narrower than h, so elevation data can show obstacles of 0.3 m only with cells of 0.3 m or finer and a vertical error below 0.3 m. Absence of detections proves nothing without such a capable, complete survey | `src/sim/footprint.ts` |
| `ASM-HARDWARE-EXTENT` | Only dimensions from sources read in the original become hardware extents. An octagonal stage "width" is read as across the corners (the smaller inscribed half-width); footpad span or reach gives the largest extent; the top of the stage (ground clearance + thickness) is its obstruction height | `src/sim/footprintEvidence.ts` |
| `ASM-SUN-DISC-VISIBILITY` | The Sun is terrain-visible while some of its disc (positive area) is above the skyline, with no minimum elevation; the visible fraction is integrated over 96 slices with the skyline linear between samples. A lower-bound skyline sample under the disc makes the verdict unknown unless the disc is wholly below it | `src/physics/discVisibility.ts`, `src/sim/visibility.ts` |
| `ASM-ECLIPSE-SPHERE` | The Earth hiding the Sun is modelled as a sphere of equatorial radius 6378.137 km with no atmosphere: refraction and transmitted light during a lunar eclipse and the Earth's flattening are ignored. Terrain and Earth are combined on the same solar disc | `src/sim/visibility.ts` |
| `ASM-SKY-RATE-BOUNDS` | The Sun moves across the lunar sky at most 0.55 deg/h and the Earth at most 0.2 deg/h (measured maxima over 2016-2036 at 4 sites: 0.511 and 0.113 deg/h); with a 1.25 safety factor and the skyline slope these bound how fast a visibility margin can change, which is what lets the event search prove an interval event-free | `src/sim/events.ts` (`RATE_BOUNDS`) |
| `ASM-EVENT-RESOLUTION` | Event search: 30 min scan, intervals halved down to 10 s while not proven event-free, events located to +/-0.5 s. Windows or gaps shorter than 10 s may be missed only inside reported unresolved intervals; the location tolerance is numerical only and says nothing about terrain, frame or ephemeris errors | `src/sim/events.ts` |
| `ASM-PV-SHARED-FRACTION` | Both panels use the site's one visible solar-disc fraction (no panel self-shading data), multiplied by the incidence cosine at the disc centre. A project approximation of the partly hidden disc | `src/sim/pv.ts` |
| `ASM-ENERGY-STEP` | Energy integration: event segments split into equal steps of at most 5 min, PV at the step midpoint; unknown PV or Earth state handled by a pessimistic and an optimistic scenario (monotone update); unmet energy below 1e-9 Wh per step is rounding | `src/sim/energy.ts` |
| `ASM-RECOMMEND-SPREAD` | Ties: scores grouped by round(S x 100) (0.01 points); historical before custom; inside a group the candidate with the largest great-circle distance to those already placed comes first (distances within 1 mm or nothing placed: stable ID). An engineering choice for "prefer spread-out sites" | `src/sim/recommend.ts` |
| `ASM-DATA-COMPLETENESS` | The data-completeness condition passes when the footprint data are adequate and the Sun and Earth states over the mission are determined (bounded short unresolved intervals allowed); it fails (insufficient data, not a hazard) otherwise | `src/sim/recommend.ts` |
| `ASM-INTERACTION` | Clock and Clear settings (UTC, speeds, plus and minus 10 calendar years, Clear range rules) as confirmed in v0.7 section 8 | `interaction.*` |

## Ephemerides and orientation

Source IDs: `SRC-ASTRONOMY-ENGINE`, `SRC-IAU-WGCCRE`, `SRC-IAU-2012-B2`, `SRC-IERS-LEAP-SECONDS`. Conventions, measured errors and limits: `docs/step-06-frames-and-ephemeris.md` (local) and `docs/SIM_API.md`.


| Used for | Source | Where in code |
|---|---|---|
| Time scale | TT = UTC + 32.184 s + (TAI - UTC) from the IERS table, installed with `SetDeltaTFunction` (`physics/timeScale.ts`); the library's Delta T polynomial (about 75 s in 2026, 82 s in 2036) is used only before 1972. UT1 is taken as UTC | `physics/timeScale.ts` |
| Sun and Moon positions (geocentric vectors) | Astronomy Engine 2.1.19 (`GeoVector`), https://github.com/cosinekitty/astronomy | `physics/ephemeris.ts`, `physics/moonFrame.ts` |
| Moon pole direction and prime meridian angle (RA, Dec, W) | Astronomy Engine `RotationAxis(Body.Moon)`, which implements the IAU WGCCRE cartographic elements: Archinal et al., "Report of the IAU Working Group on Cartographic Coordinates and Rotational Elements" (Celestial Mechanics and Dynamical Astronomy) | `physics/moonFrame.ts` |
| Earth rotation | Astronomy Engine `SiderealTime` (GAST) plus `Rotation_EQD_EQJ` (IAU 2000B nutation and precession) for the scene, and `ObserverVector` for physical sites. Before step 06 the scene ignored precession and nutation (~0.36 deg in 2026). Polar motion and UT1 - UTC are not modelled | `physics/earthFrame.ts` |
| Moon-fixed frame (+X = lon 0, +Y = 90 E, +Z = north) | Axis convention of the IAU Moon frame and of JPL Horizons `MOON_ME`, but the orientation is the IAU 2009 model, not DE421 mean Earth: step 06 measured a time-dependent 17-31 arcsec rotation between them (up to ~250 m at the surface). Coordinates in DE421 mean Earth (candidates, terrain products) are used without conversion | `physics/moonFrame.ts` |
| Astronomical unit, 149,597,870.7 km | IAU 2012 Resolution B2 | `physics/coords.ts` |

## Physical constants

Source IDs: `SRC-IAU-WGCCRE`, `SRC-IAU-2015-B3`; Earth radius from WGS-84 / IERS (not registered separately).

| Constant | Value | Source | Where |
|---|---|---|---|
| Moon radius | 1737.4 km | IAU WGCCRE (Archinal et al.); same as the Horizons target radius | `physics/siteSky.ts` |
| Earth equatorial radius | 6378.137 km | WGS-84 / IERS equatorial radius; also the Horizons center radius (IAU 2015 B3 nominal value is the rounded 6378.1 km) | `physics/siteSky.ts` |
| Sun radius | 695,700 km | IAU 2015 Resolution B3 nominal solar radius, https://www.iau.org/common/Uploaded%20files/IAUGA2015-Resolution-B3-recommended-nominal-conversion.pdf (arXiv:1510.07674) | `physics/siteSky.ts` |

The scene meshes use rounded radii (`MOON_R = 1.737`, `EARTH_R = 6.371`, in units of 1000 km). Earth uses its mean radius, because the mesh is a sphere. The site calculations use the constants above.

## Textures

Source IDs: `SRC-NASA-BLUE-MARBLE`, `SRC-NASA-SVS-MOONKIT`.

- `public/textures/earth.jpg`: NASA Earth Observatory, *Blue Marble: Next Generation with Topography and Bathymetry*, January 2004, 5400x2700 (8 km/pixel), equirectangular, lon -180 at the left edge. Produced by Reto Stöckli, NASA Earth Observatory (NASA Goddard Space Flight Center). Credit "NASA Earth Observatory".
  https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-topography-bathymetry
- `public/textures/moon.jpg`: NASA Scientific Visualization Studio, CGI Moon Kit colour map (built from Lunar Reconnaissance Orbiter imagery), downsampled to 2048x1024 and resaved in Photoshop on 2025-12-02. Equirectangular, lon 0 at the centre. Credit "NASA's Scientific Visualization Studio". **TODO: add the SVS page URL and original file name.** The Moon Kit also provides a matching LOLA displacement map, which is not used yet.

## Validation data

Source IDs: `SRC-JPL-HORIZONS` (first sample, below), `SRC-HORIZONS-API` (step 06 reference set). Step 06 results over 2016-2036: Moon centre within 13.6 km of DE441; Sun direction within 1.3 arcsec; sub-solar point within 30.5 arcsec of MOON_ME (IAU orientation vs DE421 mean Earth, 17-31 arcsec rotation); Sun and Earth seen from 14 lunar sites within 27.6 and 10.7 arcsec; Earth sites within 0.16 km. Step 06 wrap-up holdout (12 new epochs, 7 new lunar sites, transit pairs; budgets fixed before the holdout was fetched, `physics/horizonsHoldout.test.ts`): sub-solar 29.8 arcsec, sub-Earth 8.7 arcsec, Sun and Earth from lunar sites 29.8 and 7.9 arcsec, site-Earth range 9.6 km, Moon centre 13.9 km, transit time 7.7 s, Earth sites 0.083 km. These are combined residuals (orientation, ephemeris and light-time model together) unless labelled orientation-only.

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

Source IDs: `SRC-LOLA-GDR-CYL`, `SRC-LOLA-GDR-POLAR`, `SRC-SLDEM2015-PDS`, `SRC-LROC-NAC-DTM-PDS`, `SRC-PROJECT-LDEM4`; policies `ASM-OBSERVER-HEIGHT`, `ASM-SITE-ELEVATION-POLICY`, `ASM-HORIZON-PARAMETERS`, `ASM-NAC-SELECTION`.

| Product | Resolution | Coverage | Used for | Where |
|---|---|---|---|---|
| LDEM_4 | 4 pixels/deg (~7.6 km) | Global, cylindrical | Background scene terrain, `siteAt`; independent check of every projection in step 07 | `public/data/lola/ldem_4.bin` |
| LDEM_16 | 16 pixels/deg (~1.9 km) | Global, cylindrical | Not shipped; `node tools/buildDem.mjs 16` | - |
| SLDEM2015 512 ppd tiles (V2.0, FLOAT) | ~59.2 m | +/-60 deg | Mid band (1-30 km) and regional grid, 11 candidates | `public/data/terrain/v1/<site>/regional.i16` (+/-10 km) |
| SLDEM2015 128 ppd global (V2.0, FLOAT) | ~236.9 m | +/-60 deg | Far band (30-200 km), 11 candidates | Used at build time only |
| LDEM_60S_60M / LDEM_60S_240M (V2.1) | 60 m / 240 m | South of 60 S, polar stereographic | Mid and far bands, Chandrayaan-3 | `chandrayaan-3/regional.i16` (60 m, +/-10 km) |
| LROC NAC DTMs (one per site) | 2-5 m | Each DTM's footprint | Near band (0-1 km), site elevation, confidence codes | `<site>/near.i16` (+/-0.5 km), `<site>/near-conf.u8` |

Published files: little-endian int16 `valueM = offsetM + scaleM * q` (near 0.02 m, regional 0.25 m; -32768 = no data), uint8 confidence codes
(categorical, read by nearest pixel only), `horizon.json` (`HorizonData`) and `manifest.json` per site, `index.json` for all sites. Heights are metres
above the 1737.4 km sphere. Each manifest records the product IDs, versions, URLs, label-derived projection, verification results, crop, quantisation,
checksums (SHA-256 and FNV-1a) and the build settings. `tools/buildSiteTerrain.mjs` reproduces them from the PDS originals (HTTP range requests,
cache in `tools/.cache/step07`, not published). GDAL is not installed here; the projections are implemented in `src/physics/projections.ts` and
verified against label control points and against LDEM_4.

### Terrain limitations

- Grid values are stored with a quantisation step (near 0.02 m, regional 0.25 m). That is a file-format choice, not an accuracy; the vertical accuracy (RLE90, LOLA RMS, SLDEM residual) and the horizontal LOLA offset are recorded separately in each manifest (`files.*.accuracy`).
- The horizon was cast offline from +/-1.5 km, +/-31 km and +/-205 km crops (`HorizonData.inputs`); the published +/-0.5 km and +/-10 km grids cannot reproduce it.
- Nothing here resolves the maximum slope inside a 3 m footprint or rules out 0.3 m obstacles. Regional slope is reported with its real baseline (at least two regional pixels, ~118-120 m).
- No candidate horizon is complete: every site has azimuths where the near DTM has gaps or ends (lower bounds), and the Chang'e 4 near field is unscreened (confidence legend unconfirmed). `requireHorizon` returns unknown for all 12, which also fail the convergence tolerance (ASM-HORIZON-CONVERGENCE); Luna 16 and Chang'e 4 use near-field products chosen after relaxing a selection gate (a downgrade, flagged `horizon-degraded-product`), and Apollo 14, 16 and Chang'e 4 have observer elevations of non-formal quality.
- The horizon start distance (20 m) is not converged: moving it to 10 m changes single azimuths by up to 0.2-0.5 deg. Azimuth step, ray step and range are converged to within about 0.05-0.9 deg at single azimuths (means below 0.02 deg).
- NAC DTMs are registered to LOLA with stated offsets of up to 29 m (Luna 16). Grids and coordinates are never shifted; the registration search in each manifest is diagnostic only.
- Near-mid seam differences are 0.2-4.4 m mean, 1-4 m standard deviation; mid-far 2.6-5.0 m standard deviation.
- LDEM_4 (`siteAt`, `horizonAt`) remains a coarse preview path and is not used by the step-07 formal horizon.

### Products reviewed for the 12 candidate sites

Registered in the source register above (SRC-LOLA-GDR-*, SRC-SLDEM*, SRC-LROC-NAC-*, SRC-LROC-ANTHRO, SRC-WATKINS-BOULDERS) and as
structured data in `src/data/lunar-candidate-catalog-v0.1.json` (`terrainProducts`). Research record, access dates, checksums and
per-site results: `docs/step-04-data-feasibility.md`. Reproducible helpers: `tools/nacDtmCoverage.mjs` and `tools/nacDtmPointSample.mjs`.

Only the products listed there were checked. None of them resolves the maximum slope inside a 3 m footprint or rules out obstacles of
0.3 m; that statement is limited to the checked products and does not say that no finer product exists anywhere.

## Power viability simulation

> Steps 11-12 (2026-11-15): the formal power model is `src/sim/pv.ts` (fixed east/west panels, visible disc fraction, inverse-square
> irradiance, array limit) and `src/sim/energy.ts` (base + communication load, bus efficiency, battery efficiencies and limits, reserve,
> failure kept after recharging, pessimistic/optimistic bounds for unknown inputs; ASM-ENERGY-STEP). The subsections below describe the
> LEGACY binary model (`power.ts`), kept isolated for regression comparison only; its `viable` is not the power condition.


> **Status note (2026-11-14, step 02):** This section describes the current code, not the target model. The binary "any sunlight = full output" generation, the missing panel geometry, efficiencies and power limits, and the placeholder defaults conflict with requirements v0.7 §5 and `docs/reference/candidate-and-machine-reference-v0.1.md` §2–3. See `docs/step-02-requirements-map.md` (R02-38 to R02-48). The replacement is scheduled for steps 05, 11 and 12. Do not use this section as the specification. Since step 03 the legacy model uses W/Wh and takes the mission duration from a `MissionWindow`; the physics is unchanged (see `docs/step-03-contracts.md`).

The power simulation (`src/sim/power.ts`) assesses whether a spacecraft can sustain its electrical requirements throughout a specified stay at a lunar landing site. It is an intentionally idealised model. The assumptions and limitations below must be read alongside any results.

### Assumptions

1. **Binary solar generation model.** Whenever any part of the Sun's disc is above the local horizon (`sunUp` from `skyAt`), the solar panel produces its maximum rated electrical output (`maxSolarW`). When the Sun is entirely below the horizon, output is zero.
2. **Perfect Sun tracking.** Solar panels continuously face directly toward the Sun, with no orientation restrictions, tracking delays or gimbal limits.
3. **100 % conversion efficiency.** The specified maximum solar recharge rate is the maximum electrical output. Conversion losses, panel degradation, dust accumulation and temperature-related efficiency changes are excluded.
4. **No partial-illumination scaling.** Output is not proportionally reduced when only part of the panel surface is illuminated, nor when the Sun elevation is low. Any sunlight = full output.
5. **Sun elevation determines availability only.** Elevation contributes to whether the Sun is above the horizon. It does not independently attenuate output.
6. **Normal and essential power modes.** Normal vessel power consumption represents the total electrical load during standard operation. Essential-system consumption is a separate, reduced operating configuration for critical functions. They are not additive.
7. **Time-dependent consumption.** Vessel power consumption can vary during the mission via a `PowerSchedule`. Where no schedule is provided, the constant normal load is used.
8. **Battery limits enforced.** Battery charge is clamped to `[0, maxCapacity]`. Charge below the user-specified minimum reserve is recorded as a violation. Any energy demand that cannot be met is recorded as deficit.
9. **No degradation in v1.** Battery degradation, cycle-life limits, charge/discharge rate limits and other electrical component wear are excluded from the initial implementation. The architecture includes a `degradation` callback for future use.
10. **Provisional defaults.** All placeholder default values (`LEGACY_PLACEHOLDER_POWER_CONFIG`) are arbitrary and are not based on researched spacecraft specifications.

### Environmental model limitations

- **Terrain obstruction.** On a smooth sphere (no `Site.horizon`), the horizon is geometric. At polar sites this overestimates sunlight. With a LOLA horizon profile attached, the simulation respects terrain, but only at the DEM resolution (see "Terrain limitations" above).
- **Partial disc illumination detection.** The existing model reports whether any part of the Sun's disc clears the horizon. It does not report what fraction of the disc or of the panel surface is illuminated. The binary generation model treats any visibility as full output.
- **No eclipses.** Lunar eclipses (Earth blocking the Sun) are not modelled. During an eclipse the simulation will incorrectly show the Sun as up.
- **No reflected light.** Earthshine and secondary illumination are not considered.

### Calculation method

The simulation steps through the mission at a configurable interval (default 5 minutes). At each step:

1. Sun visibility is looked up from the pre-computed sun-up intervals (`windows('sun', ...)`).
2. Solar generation is `maxSolarW` if sun is up, else 0.
3. Current load is read from the schedule or defaults to `normalLoadW`.
4. Net power = solar − load.
5. Battery charge is updated: `E_next = min(capacityWh, E_current + net_W × Δt_h)`.
6. If charge would go negative, it is set to 0 and the shortfall is added to the cumulative deficit.
7. If stored energy < `minReserveWh`, the breach is recorded.

A site is classified as viable only if there is no deficit, no depletion and no reserve breach over the entire mission.

### Data sources

The legacy model above uses no external spacecraft specification. Its parameters are user-supplied or use the placeholder defaults in `LEGACY_PLACEHOLDER_POWER_CONFIG`, which cite no source because they do not represent any real vehicle. The new ILN-inspired preset (`src/data/lunar-mission-defaults-v0.1.json`) is a separate configuration with the sources and assumptions registered above; it is not connected to the legacy model.

## Not yet included

- High-resolution polar terrain (LDEM_80S_20M etc.). The Moon is a smooth sphere unless a `Horizon` is supplied. Candidate source for real horizon profiles: LRO LOLA elevation data (NASA PDS Geosciences Node).
