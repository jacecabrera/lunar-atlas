import { useState } from 'react'
import { useMission } from '../state/missionStore'
import { missionTasks } from '../state/missionTasks'
import { useApp, SIDEBAR_WIDTH } from '../state/appStore'
import { missionInputStatus, validateAdvancedSettings } from '../sim'
import { NumberField, UtcField } from './fields'
import { SETTING_GROUPS, applySettingText, derivedSettings, draftFieldErrors, settingText, statusView } from './formModel'
import type { SettingField } from './formModel'
import { parseNumberText } from './formModel'

// Right sidebar (step 18): the three main inputs, Calculate with status and progress, and More settings.
// Step 19 adds the recommendation list and custom sites below the status. Inputs start empty; nothing is pre-filled
// from the clock. The sidebar is plain DOM outside the canvas, so scrolling or clicking it never drives the 3D scene.

const panel: React.CSSProperties = {
  position: 'fixed', top: 0, right: 0, bottom: 0, width: SIDEBAR_WIDTH, overflowY: 'auto', overscrollBehavior: 'contain',
  boxSizing: 'border-box', padding: '12px 14px 24px', color: '#eee', background: 'rgba(12,14,20,0.92)', font: '13px system-ui, sans-serif', borderLeft: '1px solid #333',
}
const h2: React.CSSProperties = { fontSize: 14, margin: '14px 0 8px' }

function MissionInputs({ showErrors }: { showErrors: boolean }) {
  const draft = useMission((s) => s.draft)
  const setDraft = useMission((s) => s.setDraft)
  const errors = draftFieldErrors(draft)
  const touchedAny = Object.values(draft).some((v) => v !== null)
  const show = showErrors || touchedAny
  return (
    <section aria-label="Mission inputs">
      <h2 style={h2}>Mission</h2>
      <UtcField label="Landing Time" unit="UTC" value={draft.landingTimeMs} onValue={(v) => setDraft({ landingTimeMs: v })} error={errors.landingTimeMs} showError={show && draft.landingTimeMs !== null || showErrors}
        help="Touchdown instant. The surface mission starts here." />
      <NumberField label="Duration of journey" unit="Earth days" value={draft.durationDays} onValue={(v) => setDraft({ durationDays: v })} error={errors.durationDays} showError={show && draft.durationDays !== null || showErrors}
        help="Length of the stay on the lunar surface (not the Earth-Moon transit)." />
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}><NumberField label="Launch site latitude" unit="deg, N+" value={draft.launchLat} onValue={(v) => setDraft({ launchLat: v })} error={errors.launchLat} showError={show && draft.launchLat !== null || showErrors} /></div>
        <div style={{ flex: 1 }}><NumberField label="Launch site longitude" unit="deg, E+" value={draft.launchLon} onValue={(v) => setDraft({ launchLon: v })} error={errors.launchLon} showError={show && draft.launchLon !== null || showErrors} /></div>
      </div>
    </section>
  )
}

function CalculatePanel({ onAttempt }: { onAttempt: () => void }) {
  const draft = useMission((s) => s.draft)
  const settings = useMission((s) => s.settings)
  const task = useMission((s) => s.task)
  const progress = useMission((s) => s.progress)
  // Rejection reasons belong to the inputs they were produced for; any edit hides them.
  const [rejection, setRejection] = useState<{ reasons: string[]; draft: unknown; settings: unknown } | null>(null)
  const rejected = rejection && rejection.draft === draft && rejection.settings === settings ? rejection.reasons : null
  const view = statusView(missionInputStatus(draft), task, progress, rejected)
  return (
    <section aria-label="Calculation">
      <button style={{ width: '100%', padding: '6px 0', fontWeight: 600 }} onClick={() => {
        onAttempt()
        const out = missionTasks().calculate()
        setRejection(out.accepted ? null : { reasons: out.reasons, draft, settings })
      }}>Calculate</button>
      <div role="status" aria-live="polite" data-status={view.kind} style={{ marginTop: 8, padding: 8, border: '1px solid #444', borderRadius: 4 }}>
        <strong>Status: {view.title}</strong>
        {view.lines.map((l, i) => <div key={i} style={{ fontSize: 12, marginTop: 2 }}>{l}</div>)}
      </div>
    </section>
  )
}

function SettingInput({ f }: { f: SettingField }) {
  const settings = useMission((s) => s.settings)
  const setSettings = useMission((s) => s.setSettings)
  const value = f.get(settings)
  const [text, setText] = useState(settingText(f, settings))
  const [seen, setSeen] = useState(value)
  if (!(seen === value || (Number.isNaN(seen) && Number.isNaN(value)))) {
    // Keep the typed text unless the stored value changed from outside (e.g. reset to defaults).
    setSeen(value)
    const typed = parseNumberText(text)
    const typedStored = typed === null || Number.isNaN(typed) ? Number.NaN : f.scale === 'percent' ? typed / 100 : typed
    if (!(Math.abs(typedStored - value) < 1e-12 || (Number.isNaN(typedStored) && Number.isNaN(value)))) setText(settingText(f, settings))
  }
  const id = `setting-${f.key}`
  return (
    <div style={{ marginBottom: 6 }}>
      <label htmlFor={id} style={{ display: 'block', fontSize: 12, opacity: 0.85 }}>{f.label}{f.unit ? ` (${f.unit})` : ''}</label>
      <input id={id} value={text} inputMode="decimal" style={{ width: '100%', boxSizing: 'border-box', fontFamily: 'ui-monospace, monospace' }}
        onChange={(e) => { setText(e.target.value); setSettings(applySettingText(f, useMission.getState().settings, e.target.value)) }} />
      {f.help && <div style={{ fontSize: 11, opacity: 0.65 }}>{f.help}</div>}
    </div>
  )
}

function MoreSettings() {
  const settings = useMission((s) => s.settings)
  const resetSettings = useMission((s) => s.resetSettings)
  const errors = validateAdvancedSettings(settings)
  const d = derivedSettings(settings)
  return (
    <details style={{ marginTop: 14 }}>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>More settings</summary>
      <p style={{ fontSize: 11, opacity: 0.75 }}>
        Preset: ILN-inspired solar lander (teaching configuration after NASA ILN Case 1; several values are project assumptions,
        not a flight-hardware specification or a NASA standard). Changing a setting marks earlier results out of date.
      </p>
      {SETTING_GROUPS.map((g) => (
        <fieldset key={g.title} style={{ border: '1px solid #333', margin: '8px 0', padding: '6px 8px' }}>
          <legend style={{ fontSize: 12 }}>{g.title}</legend>
          {g.fields.map((f) => <SettingInput key={f.key} f={f} />)}
          {g.title === 'Solar panels' && <div style={{ fontSize: 12 }}>Total panel area (derived): {d.totalPanelAreaM2 === null ? 'invalid' : `${d.totalPanelAreaM2.toFixed(4)} m²`}</div>}
          {g.title === 'Battery' && <div style={{ fontSize: 12 }}>Minimum reserve (derived): {d.reserveWh === null ? 'invalid' : `${Math.round(d.reserveWh)} Wh`}</div>}
          {g.title === 'Score weights' && <div style={{ fontSize: 12 }}>{d.normalizedWeights
            ? `Used after normalisation: sunlight ${(d.normalizedWeights.sunlight * 100).toFixed(1)}%, Earth ${(d.normalizedWeights.earth * 100).toFixed(1)}%, terrain ${(d.normalizedWeights.terrain * 100).toFixed(1)}%`
            : 'Invalid: weights must be finite, non-negative and not all zero'}</div>}
        </fieldset>
      ))}
      <div style={{ fontSize: 12, opacity: 0.8 }}>Terrain screening (project settings, not editable here): {settings.footprintDiameterM} m footprint, slope limit {settings.slopeLimitDeg}°, obstacle limit {settings.obstacleLimitM} m.</div>
      {errors.length > 0 && <div role="alert" style={{ color: '#ffb4a8', fontSize: 12, marginTop: 6 }}>{errors.map((e) => <div key={e}>Error: {e}</div>)}</div>}
      <button style={{ marginTop: 8 }} onClick={resetSettings} title="Restores the preset values; keeps the mission inputs and the time lock">Restore default settings</button>
    </details>
  )
}

export default function Sidebar({ children }: { children?: React.ReactNode }) {
  const open = useApp((s) => s.sidebarOpen)
  const toggle = useApp((s) => s.toggleSidebar)
  const [attempted, setAttempted] = useState(false)
  return (
    <>
      {!open && <button onClick={toggle} aria-expanded={false} aria-controls="mission-sidebar" style={{ position: 'fixed', top: 12, right: 12, zIndex: 2 }}>Show panel</button>}
      {open && (
        <aside id="mission-sidebar" aria-label="Mission panel" style={panel}>
          <button onClick={toggle} aria-expanded aria-controls="mission-sidebar" style={{ float: 'right' }}>Hide panel</button>
          <MissionInputs showErrors={attempted} />
          <CalculatePanel onAttempt={() => setAttempted(true)} />
          {children}
          <MoreSettings />
        </aside>
      )}
    </>
  )
}
