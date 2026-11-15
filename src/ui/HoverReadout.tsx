import { useCustomSites } from '../state/customSites'
import { useMission } from '../state/missionStore'
import { missionTasks } from '../state/missionTasks'
import { hoverStatus } from '../state/customSitesModel'
import { loadCandidateCatalog } from '../sim'
import { SAME_SITE_TOLERANCE_DEG } from '../sim/job'

// Moon coordinate under the pointer (sphere pick) and what is already known there, without starting an evaluation.
// Known unconfirmable points are shown in red with words that say why (proven failure, not enough data or service
// error). The decimals are not a positioning accuracy and the sphere is not a terrain model.
const catalog = loadCandidateCatalog()
const isCatalogue = (lat: number, lon: number) => catalog.candidates.some((c) => Math.abs(c.coordinate.lat - lat) < SAME_SITE_TOLERANCE_DEG && Math.abs(c.coordinate.lon - lon) < SAME_SITE_TOLERANCE_DEG)
const color = { neutral: 'var(--bright)', ok: 'var(--ok)', fail: 'var(--err)', unknown: 'var(--warn)', error: 'var(--err)' } as const

export default function HoverReadout({ right }: { right: number }) {
  const hover = useCustomSites((s) => s.hover)
  const task = useMission((s) => s.task)
  if (!hover) return null
  const st = hoverStatus(hover, task, isCatalogue, (k) => missionTasks().cachedSite(k))
  return (
    <div aria-live="off" data-testid="moon-hover" className="readout mono" style={{ position: 'fixed', bottom: 84, right: right + 12, maxWidth: 420, padding: '4px 10px', fontSize: 12 }}>
      <div>Moon {hover.lat.toFixed(3)}°, {hover.lon.toFixed(3)}° (click to use; sphere pick)</div>
      <div data-testid="moon-hover-status" style={{ color: color[st.tone], fontFamily: 'var(--ui)' }}>{st.label}</div>
    </div>
  )
}
