import { useState } from 'react'
import { useMission } from '../state/missionStore'
import { missionTasks } from '../state/missionTasks'
import { useApp, SIDEBAR_WIDTH } from '../state/appStore'
import { missionInputStatus, validateAdvancedSettings } from '../sim'
import { NumberField, UtcField } from './fields'
import { SETTING_GROUPS, applySettingText, derivedSettings, draftFieldErrors, settingText, statusView } from './formModel'
import type { SettingField } from './formModel'
import { parseNumberText } from './formModel'
import ClearReset from './ClearReset'

// Right sidebar (step 18): the three main inputs, More settings, then Calculate with status and progress.
// Step 19 adds the recommendation list and custom sites below the status. Inputs start empty; nothing is pre-filled
// from the clock. The sidebar is plain DOM outside the canvas, so scrolling or clicking it never drives the 3D scene.

const panel: React.CSSProperties = {
  position: 'fixed', top: 0, right: 0, bottom: 0, width: SIDEBAR_WIDTH, overflowY: 'auto', overscrollBehavior: 'contain',
  boxSizing: 'border-box', padding: '12px 14px 24px',
}
const h2: React.CSSProperties = { margin: '16px 0 8px' }

function MissionInputs({ showErrors }: { showErrors: boolean }) {
  const draft = useMission((s) => s.draft)
  const setDraft = useMission((s) => s.setDraft)
  const errors = draftFieldErrors(draft)
  const touchedAny = Object.values(draft).some((v) => v !== null)
  const show = showErrors || touchedAny
  return (
    <section aria-label="Mission inputs">
      <h2 className="upper-label" style={h2}>Mission</h2>
      <UtcField label="Landing Time" unit="UTC" value={draft.landingTimeMs} onValue={(v) => setDraft({ landingTimeMs: v })} error={errors.landingTimeMs} showError={show && draft.landingTimeMs !== null || showErrors}
        help="Touchdown instant. The surface mission starts here." />
      <NumberField label="Duration of journey" unit="Earth days" value={draft.durationDays} onValue={(v) => setDraft({ durationDays: v })} error={errors.durationDays} showError={show && draft.durationDays !== null || showErrors}
        help="Length of the stay on the lunar surface (not the Earth-Moon transit)." />
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}><NumberField unitOnNewLine label="Launch site latitude" unit="deg, N+" value={draft.launchLat} onValue={(v) => setDraft({ launchLat: v })} error={errors.launchLat} showError={show && draft.launchLat !== null || showErrors} /></div>
        <div style={{ flex: 1, minWidth: 0 }}><NumberField unitOnNewLine label="Launch site longitude" unit="deg, E+" value={draft.launchLon} onValue={(v) => setDraft({ launchLon: v })} error={errors.launchLon} showError={show && draft.launchLon !== null || showErrors} /></div>
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
  const tone = { empty: 'tone-wait', invalid: 'tone-warn', ready: 'tone-wait', running: 'tone-busy', done: 'tone-ok', 'no-eligible': 'tone-warn', stale: 'tone-warn', error: 'tone-err' }[view.kind]
  const head = { empty: 'AWAITING INPUT', invalid: 'INPUT INVALID', ready: 'READY TO CALCULATE', running: 'COMPUTING', done: 'SOLUTION FOUND', 'no-eligible': 'NO ELIGIBLE SITE', stale: 'OUT OF DATE', error: 'CALCULATION FAILED' }[view.kind]
  const running = task.status === 'running'
  return (
    <section aria-label="Calculation">
      <button className={`btn-primary${running ? ' loading' : ''}`} style={{ width: '100%', padding: '7px 0', marginTop: 12 }} onClick={() => {
        onAttempt()
        const out = missionTasks().calculate()
        setRejection(out.accepted ? null : { reasons: out.reasons, draft, settings })
      }}>{running ? 'Calculating…' : 'Calculate'}</button>
      <div className="hint" style={{ marginTop: 4 }} data-testid="mode-line">Assessment mode: {MODE_TEXT[settings.assessmentMode].label} (change it in More settings)</div>
      <div role="status" aria-live="polite" data-status={view.kind} key={view.kind} className={`status-card ${tone} status-flash`}>
        <div>
          <div className="status-head">{head}</div>
          <div className="status-line">{view.title}</div>
          {view.lines.map((l, i) => <div key={i} className="status-line">{l}</div>)}
        </div>
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
      <label htmlFor={id} className="field-label">{f.label}{f.unit ? <span className="field-unit"> ({f.unit})</span> : ''}</label>
      <input id={id} value={text} inputMode="decimal" className="hud-input mono" style={{ width: '100%' }}
        onChange={(e) => { setText(e.target.value); setSettings(applySettingText(f, useMission.getState().settings, e.target.value)) }} />
      {f.help && <div className="hint">{f.help}</div>}
    </div>
  )
}

const MODE_TEXT = {
  relaxed: { label: 'Regional estimate', help: 'Default. Runs the same models on labelled estimated inputs: regional slope of a 1.9 km global product, a nominal skyline, nominal energy and communication. Obstacles and footprint-scale slope are not evaluated and are shown as risks. Proven hazards, no Earth contact and insufficient energy still exclude a point. Results are estimates, not evidence.' },
  strict: { label: 'Evidence-based assessment', help: 'Keeps the original evidence rules: footprint-scale slope and obstacle evidence, formal horizon quality gate, proven bounds. With today\'s data most sites stay "not enough data". Never switches to the estimate by itself.' },
} as const

function ModeChoice() {
  const settings = useMission((s) => s.settings)
  const setSettings = useMission((s) => s.setSettings)
  return (
    <fieldset style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius)', margin: '8px 0', padding: '6px 8px' }}>
      <legend style={{ fontSize: 12, color: 'var(--muted)' }}>Assessment mode</legend>
      {(['relaxed', 'strict'] as const).map((m) => (
        <div key={m} style={{ marginBottom: 6 }}>
          <label style={{ fontSize: 12, color: 'var(--bright)' }}><input type="radio" name="assessment-mode" checked={settings.assessmentMode === m} onChange={() => setSettings({ ...settings, assessmentMode: m })} /> {MODE_TEXT[m].label}{m === 'relaxed' ? ' (default)' : ''}</label>
          <div className="hint" style={{ marginLeft: 20 }}>{MODE_TEXT[m].help}</div>
        </div>
      ))}
      <label style={{ fontSize: 12, opacity: settings.assessmentMode === 'relaxed' ? 1 : 0.5 }}>
        <input type="checkbox" checked={settings.search.enabled} disabled={settings.assessmentMode !== 'relaxed'} onChange={(e) => setSettings({ ...settings, search: { ...settings.search, enabled: e.target.checked } })} /> Search the whole Moon when no catalogue site qualifies
      </label>
      <div className="hint" style={{ marginLeft: 20 }}>Regional estimate only. Evaluates a coarse grid, then refines the best regions; it lists the best points it evaluated, not a proven optimum.</div>
    </fieldset>
  )
}

function MoreSettings() {
  const settings = useMission((s) => s.settings)
  const resetSettings = useMission((s) => s.resetSettings)
  const errors = validateAdvancedSettings(settings)
  const d = derivedSettings(settings)
  return (
    <details className="hud-details" style={{ margin: '4px 0 12px' }}>
      <summary>More settings</summary>
      <p className="hint">
        Preset: ILN-inspired solar lander (teaching configuration after NASA ILN Case 1; several values are project assumptions,
        not a flight-hardware specification or a NASA standard). Changing a setting marks earlier results out of date.
      </p>
      <ModeChoice />
      {SETTING_GROUPS.map((g) => (
        <fieldset key={g.title} style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius)', margin: '8px 0', padding: '6px 8px' }}>
          <legend style={{ fontSize: 12, color: 'var(--muted)' }}>{g.title}</legend>
          {g.fields.map((f) => <SettingInput key={f.key} f={f} />)}
          {g.title === 'Solar panels' && <div className="hint">Total panel area (derived): {d.totalPanelAreaM2 === null ? 'invalid' : `${d.totalPanelAreaM2.toFixed(4)} m²`}</div>}
          {g.title === 'Battery' && <div className="hint">Minimum reserve (derived): {d.reserveWh === null ? 'invalid' : `${Math.round(d.reserveWh)} Wh`}</div>}
          {g.title === 'Score weights' && <div className="hint">{d.normalizedWeights
            ? `Used after normalisation: sunlight ${(d.normalizedWeights.sunlight * 100).toFixed(1)}%, Earth ${(d.normalizedWeights.earth * 100).toFixed(1)}%, terrain ${(d.normalizedWeights.terrain * 100).toFixed(1)}%`
            : 'Invalid: weights must be finite, non-negative and not all zero'}</div>}
        </fieldset>
      ))}
      <div className="hint">Evidence-based assessment screening (project settings, not editable here): {settings.footprintDiameterM} m footprint, slope limit {settings.slopeLimitDeg}°, obstacle limit {settings.obstacleLimitM} m. Regional estimate: slope limit {settings.regionalSlopeLimitDeg}° over about 3.8 km.</div>
      {errors.length > 0 && <div role="alert" className="error-text" style={{ marginTop: 6 }}>{errors.map((e) => <div key={e}>Error: {e}</div>)}</div>}
      <button className="hud-btn" style={{ marginTop: 8 }} onClick={resetSettings} title="Restores the preset values; keeps the mission inputs and the time lock">Restore default settings</button>
    </details>
  )
}

export default function Sidebar({ children }: { children?: React.ReactNode }) {
  const open = useApp((s) => s.sidebarOpen)
  const toggle = useApp((s) => s.toggleSidebar)
  const [attempted, setAttempted] = useState(false)
  return (
    <>
      {/* Collapsed: a symbol tab on the right edge, vertically centred (the canvas and the time bar use the full width then). */}
      {!open && (
        <button onClick={toggle} aria-expanded={false} aria-controls="mission-sidebar" aria-label="Show the mission panel" data-testid="sidebar-tab" title="Show the mission panel" className="glass"
          style={{ position: 'fixed', top: '50%', right: 0, transform: 'translateY(-50%)', padding: '16px 4px', fontSize: 14, lineHeight: 1, borderRadius: 'var(--radius) 0 0 var(--radius)', zIndex: 2, border: '1px solid var(--line-strong)', borderRight: 0, cursor: 'pointer', color: 'var(--accent)' }}>≪</button>
      )}
      {open && (
        <aside id="mission-sidebar" aria-label="Mission panel" className="glass panel-edge" style={panel}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <ClearReset />
          </div>
          {/* Collapse: a symbol button pinned to the middle of the panel's right edge (fixed, so it stays while the panel scrolls). */}
          <button onClick={toggle} aria-expanded aria-controls="mission-sidebar" aria-label="Hide panel" title="Hide the mission panel"
            className="glass"
            style={{ position: 'fixed', top: '50%', right: 4, transform: 'translateY(-50%)', padding: '16px 3px', fontSize: 14, lineHeight: 1, zIndex: 3, borderRadius: 'var(--radius)', border: '1px solid var(--line-strong)', cursor: 'pointer', color: 'var(--accent)' }}>≫</button>
          <MissionInputs showErrors={attempted} />
          <MoreSettings />
          <CalculatePanel onAttempt={() => setAttempted(true)} />
          {children}
        </aside>
      )}
    </>
  )
}
