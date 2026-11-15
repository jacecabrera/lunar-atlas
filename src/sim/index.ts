// Public API of the simulation layer. UI and scene code import from here, not from src/physics/* or individual
// sim modules. This file only re-exports: domain modules import each other directly, never through this barrel.
//
// Conventions (details in units.ts and docs/step-03-contracts.md)
//   Time       absolute: UTC ms since the Unix epoch (suffix Ms); relative to landing: suffix OffsetMs
//   Latitude   degrees, north positive, -90..90
//   Longitude  degrees, EAST positive (use -180..180 for display and input)
//   Azimuth    degrees clockwise from local north, 0..360
//   Elevation  degrees above the local horizontal plane (negative = below)
//   Distance   km; power W; energy Wh (battery internal terminal); integration in hours
//   Scene      1 unit = 1000 km, Earth at the origin, Y up (celestial north), Moon follows the real orbit

export type { Mat3, Vec3 } from '../physics/moonFrame'
export type { SkyBody } from '../physics/siteSky'
export type { Interval, SkyEvent, Target, VisibilityOptions } from '../physics/siteTimeline'
export type { Horizon } from '../physics/horizon'
export { findEvents, statusAt, summarize, intersect, DAY_MS, MINUTE } from '../physics/siteTimeline'
export { horizonFromProfile, horizonFromSamples, flatHorizon } from '../physics/horizon'
export { latLonToVec3, vec3ToLatLon } from '../physics/coords'

export * from './units'
export type * from './provenance'
export * from './mission'
export * from './defaults'
export * from './catalog'
export * from './assessment'
export * from './horizonData'
export { visibilityModel, VISIBILITY_MODEL } from './visibility'
export { searchEvents, nextSet, missionStatistics, RATE_BOUNDS, EVENTS_MODEL } from './events'
export type { Channel, TriState, EventSearchOptions, EventSearchResult, VisibilityEvent, EventCause, StateSegment, NextSet, NextSetQuery, MissionStatistics, SunElevationPoint } from './events'
export type { VisibilityModel, SunVisibility, EarthVisibility, BodyGeometry, VisibilitySite } from './visibility'
export { createSiteTerrainStore, siteTerrain, TerrainLoadError, TERRAIN_DATA_VERSION, fnv1a32 } from './siteTerrain'
export type { SiteTerrain, SiteElevation, RegionalSlope, TerrainLoadState, TerrainErrorKind, SiteTerrainManifest } from './siteTerrain'
export { assessFootprint, footprintConfig, hazardOverlap, workingBoundM, combineTerrain, FOOTPRINT_POLICY, FOOTPRINT_MODEL } from './footprint'
export type {
  FootprintConfig, FootprintInput, FootprintAssessment, FootprintDtm, ObstacleSurvey, ObstacleDetection, KnownHazard, HazardOverlap,
  HazardOverlapStatus, StatedUncertainty, UncertaintyStatistic, DataProblem,
} from './footprint'
export { candidateFootprintInput, assessCandidateFootprint, primaryHardwareHazard, nearbyHazards, hardwarePositionUncertainty, nacFootprintDtm } from './footprintEvidence'
export * from './task'
export * from './snapshot'

export { earthSiteGeocentric, moonSiteGeocentric, separationKm, DEFAULT_LAUNCH_HEIGHT_M } from './frames'
export type { GeocentricPosition, EarthSite, MoonSite } from './frames'
export { TIME_SCALE_MODEL, ttMinusUtcSeconds, taiMinusUtcSeconds, LEAP_SECONDS_VALID_UNTIL_UTC } from '../physics/timeScale'

export { sceneState, moonPosition, sunDirection } from './scene'
export type { SceneState } from './scene'

export { siteAt, skyAt, windows, nextEvent, compareSites, panelFactor } from './site'
export type { Site, SkyState } from './site'

export { loadTerrain, setTerrain, terrainLoaded, terrainAt, horizonProfileAt, horizonAt, horizonDataAt } from './terrain'
export type { TerrainPoint, HorizonOptions } from './terrain'

export {
  validateConfig, validateSchedule, simulatePower, assessViability, isViable,
  legacyPowerConfigFromKw, LEGACY_PLACEHOLDER_POWER_CONFIG,
} from './power'
export type {
  LegacyPowerConfig, LegacyPowerConfigKw, LegacyPowerResult, PowerSchedule, PowerSegment, PowerState,
  SimulateOptions, AssessOptions, ValidationError,
} from './power'
