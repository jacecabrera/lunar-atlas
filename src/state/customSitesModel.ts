// Custom sites (step 19): pure rules. The editor (draft) is separate from the confirmed list; identity is a stable ID,
// never the name or the list index. A site's evaluation only counts for the task fingerprint and coordinates it was
// computed for (customSiteKey); anything else is "not assessed for the current inputs".
import { qualified, decisionSummary } from '../sim'
import type { PointData, SiteAssessment, TaskState, TransitEstimate } from '../sim'
import { customSiteKey } from './taskScheduler'

export type CustomEvaluation =
  | { state: 'not-assessed' }
  | { state: 'evaluating'; requestId: string; key: string }
  | { state: 'assessed'; key: string; assessment: SiteAssessment; transit?: TransitEstimate; pointData?: PointData }
  | { state: 'error'; key: string; message: string }

export type CustomSite = { id: string; name: string; lat: number | null; lon: number | null; evaluation: CustomEvaluation }

export const validCoordinate = (s: Pick<CustomSite, 'lat' | 'lon'>) =>
  s.lat !== null && s.lon !== null && Number.isFinite(s.lat) && Number.isFinite(s.lon) && s.lat >= -90 && s.lat <= 90 && s.lon >= -180 && s.lon <= 180

/** The task fingerprint whose results are current (done, not stale), or null. */
export const currentFingerprint = (task: TaskState) => (task.status === 'done' ? task.result.fingerprint : null)

/** The assessment that applies to the site now, or null (none, stale, other coordinates or another task). */
export function currentAssessment(site: CustomSite, task: TaskState): SiteAssessment | null {
  const fp = currentFingerprint(task)
  if (!fp || !validCoordinate(site) || site.evaluation.state !== 'assessed') return null
  return site.evaluation.key === customSiteKey(fp, site.lat!, site.lon!) ? site.evaluation.assessment : null
}

export type ConfirmCheck = { ok: boolean; reasons: string[] }

/** Every rule that must hold before a site can be confirmed (or count as valid when already confirmed). */
export function confirmCheck(site: CustomSite, task: TaskState, confirmedCount: number, max: number, alreadyConfirmed = false): ConfirmCheck {
  const reasons: string[] = []
  // The number of catalogue recommendations does not matter: a custom site is judged by its own assessment under the task's mode.
  if (task.status === 'stale') reasons.push('The mission results are out of date; calculate again')
  else if (task.status !== 'done') reasons.push('Calculate the mission first')
  if (!validCoordinate(site)) reasons.push('Enter a valid latitude (-90..90) and longitude (-180..180)')
  const a = currentAssessment(site, task)
  if (!a) {
    if (site.evaluation.state === 'evaluating') reasons.push('Assessment in progress')
    else if (site.evaluation.state === 'error') reasons.push(`Assessment failed: ${site.evaluation.message}`)
    else reasons.push('Not assessed for the current inputs')
  } else if (!qualified(a)) {
    const s = decisionSummary(a)
    if (s.failed.length) reasons.push(`Shown not to meet: ${s.failed.join(', ')}`)
    if (s.errored.length) reasons.push(`Service error in: ${s.errored.join(', ')}`)
    if (s.undetermined.length) reasons.push(`Not enough data to decide: ${s.undetermined.join(', ')}`)
  }
  if (!alreadyConfirmed && confirmedCount >= max) reasons.push(`At most ${max} custom sites`)
  return { ok: reasons.length === 0, reasons }
}

/** A confirmed site that still counts for the current mission: eligible current assessment and every rule holds. */
export const isValidCustom = (site: CustomSite, task: TaskState, confirmedCount: number, max: number) => {
  const a = currentAssessment(site, task)
  return !!a && qualified(a) && confirmCheck(site, task, confirmedCount, max, true).ok
}

/** Short state label for the UI (never "safe" for unknown, never "dangerous" for missing data). */
export function siteStateLabel(site: CustomSite, task: TaskState): { label: string; tone: 'neutral' | 'busy' | 'ok' | 'fail' | 'unknown' | 'error' } {
  if (site.evaluation.state === 'evaluating') return { label: 'Assessing…', tone: 'busy' }
  const a = currentAssessment(site, task)
  if (!a) {
    if (site.evaluation.state === 'error') return { label: 'Assessment failed (service error)', tone: 'error' }
    if (site.evaluation.state === 'assessed') return { label: 'Out of date: check again', tone: 'neutral' }
    return { label: 'Not assessed', tone: 'neutral' }
  }
  const s = decisionSummary(a)
  if (qualified(a)) return { label: a.decision?.estimated ? 'Regional estimate: all necessary conditions pass (estimated, not evidence)' : 'All necessary conditions pass (current model)', tone: 'ok' }
  if (s.failed.length) return { label: `Shown not to meet: ${s.failed.join(', ')}`, tone: 'fail' }
  if (s.errored.length) return { label: `Service error: ${s.errored.join(', ')}`, tone: 'error' }
  return { label: `Not enough data: ${s.undetermined.join(', ')}`, tone: 'unknown' }
}

export type HoverStatus = { label: string; tone: 'neutral' | 'fail' | 'unknown' | 'error' | 'ok' }

/**
 * What can be said about the point under the pointer without starting an evaluation: a cached assessment for exactly
 * these (click-rounded) coordinates and the current task, or the known absence of a terrain product away from the
 * catalogue coordinates. Otherwise "Not assessed". Never "safe" or "dangerous" without evidence.
 */
export function hoverStatus(
  hover: { lat: number; lon: number }, task: TaskState, isCatalogueCoordinate: (lat: number, lon: number) => boolean,
  cached: (key: string) => SiteAssessment | null,
): HoverStatus {
  const fp = currentFingerprint(task)
  if (!fp) return { label: 'Not assessed (calculate the mission first)', tone: 'neutral' }
  const lat = Number(hover.lat.toFixed(4)), lon = Number(hover.lon.toFixed(4))
  const a = cached(customSiteKey(fp, lat, lon))
  const relaxed = task.status === 'done' && task.result.mode === 'relaxed'
  if (a) {
    const s = decisionSummary(a)
    if (s.failed.length) return { label: `Cannot be confirmed: shown not to meet ${s.failed.join(', ')}`, tone: 'fail' }
    if (s.errored.length) return { label: `Cannot be confirmed: service error in ${s.errored.join(', ')}`, tone: 'error' }
    if (s.undetermined.length) return { label: `Cannot be confirmed: not enough data (${s.undetermined.join(', ')})`, tone: 'unknown' }
    return { label: a.decision?.estimated ? 'Regional estimate: all necessary conditions pass (estimated, not evidence)' : 'All necessary conditions pass (current model)', tone: 'ok' }
  }
  // Regional estimate mode can assess any coordinate from the global terrain: not assessed yet, not unavailable.
  if (relaxed) return { label: 'Not assessed yet: Check site runs a regional estimate for this point', tone: 'neutral' }
  if (!isCatalogueCoordinate(lat, lon)) return { label: `Cannot be confirmed: not enough data (no terrain product for this point)`, tone: 'unknown' }
  return { label: 'Not assessed', tone: 'neutral' }
}
