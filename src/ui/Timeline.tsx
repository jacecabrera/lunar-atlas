import { useState } from 'react'
import { useTime, CLOCK_CONFIG } from '../state/timeStore'
import { useMission } from '../state/missionStore'
import { formatUtc, parseUtcInput } from '../time/clock'

// Time controls (step 16). v0.7 section 8: UTC time, play/pause and speed at the top left; the slider, exact jump and
// range fields along the bottom. Every action goes through the store, which refuses changes while a calculation lock
// is active; disabling the controls is only a visual hint. All times are UTC; typed times are parsed strictly.
// Styling follows docs/style-plan.md (mission console): the clock is the brightest readout, the slider is a thin
// glowing line with month ticks and a "now" line; the accepted task window is a translucent band. Display only.
const bar: React.CSSProperties = { position: 'fixed', bottom: 8, left: 0, right: 0, padding: '6px 12px 8px' }
const corner: React.CSSProperties = { position: 'fixed', top: 12, left: 12, padding: '6px 10px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', maxWidth: 'calc(100vw - 24px)' }
const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }
const field: React.CSSProperties = { width: 185 }
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/** Month boundaries in the range (or year boundaries for very wide ranges); display only. */
function ticks(min: number, max: number): { label: string; pct: number }[] {
  const span = max - min
  const out: { label: string; pct: number }[] = []
  const d = new Date(min)
  d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0)
  const byMonth = span < 20 * 31 * 86_400_000
  if (!byMonth) d.setUTCMonth(0, 1)
  while (d.getTime() < max) {
    const t = d.getTime()
    if (t >= min) out.push({ label: byMonth ? MONTHS[d.getUTCMonth()] : String(d.getUTCFullYear()), pct: ((t - min) / span) * 100 })
    if (byMonth) d.setUTCMonth(d.getUTCMonth() + 1); else d.setUTCFullYear(d.getUTCFullYear() + 1)
  }
  return out
}

export default function Timeline({ right = 0 }: { right?: number }) {
  const { t, min, max, playing, rate, lock, notice, togglePlay, setRate, seek, setRange, jumpToNow } = useTime()
  const draft = useMission((s) => s.draft)
  const task = useMission((s) => s.task)
  const [jump, setJump] = useState('')
  const [start, setStart] = useState<string | null>(null)
  const [end, setEnd] = useState<string | null>(null)
  const [inputError, setInputError] = useState<string | null>(null)
  const locked = lock !== null

  const goTo = () => {
    const ms = parseUtcInput(jump)
    if (ms === null) { setInputError('Enter a UTC time as YYYY-MM-DD HH:MM:SS'); return }
    setInputError(null)
    seek(ms)
  }
  const applyRange = () => {
    const a = parseUtcInput(start ?? formatUtc(min).replace(' UTC', ''))
    const b = parseUtcInput(end ?? formatUtc(max).replace(' UTC', ''))
    if (a === null || b === null) { setInputError('Enter range bounds as YYYY-MM-DD HH:MM:SS (UTC)'); return }
    setInputError(null)
    setRange(a, b)
    setStart(null); setEnd(null)
  }

  const span = max - min
  const fillPct = span > 0 ? ((t - min) / span) * 100 : 50
  const [nowMs] = useState(() => Date.now())
  const nowInRange = nowMs >= min && nowMs <= max
  const showWindow = task.status === 'done' && draft.landingTimeMs !== null && draft.durationDays !== null && draft.durationDays > 0
  const winStart = showWindow ? draft.landingTimeMs! : 0
  const winEnd = showWindow ? winStart + draft.durationDays! * 86_400_000 : 0
  const winPct = showWindow && span > 0 ? { left: Math.max(0, ((winStart - min) / span) * 100), width: Math.min(100, ((winEnd - min) / span) * 100) - Math.max(0, ((winStart - min) / span) * 100) } : null

  return (
    <>
    <div className="glass" style={{ ...corner, maxWidth: `calc(100vw - ${24 + right}px)` }}>
      <span className="clock-readout mono" aria-label="Simulation time (UTC)">{formatUtc(t)}<span className="clock-utc">UTC</span></span>
      <span className="capsule">
        <button className="capsule-btn" onClick={togglePlay} disabled={locked} aria-label={playing ? 'Pause' : 'Play'}>{playing ? 'Pause' : 'Play'}</button>
        <span className="seg" role="group" aria-label="Playback speed">
          {CLOCK_CONFIG.playbackSpeeds.map((r) => (
            <button key={r} className={`seg-btn${r === rate ? ' on' : ''}`} onClick={() => setRate(r)} disabled={locked} aria-pressed={r === rate}>{r}x</button>
          ))}
        </span>
      </span>
      {locked && <span className="mono" style={{ fontSize: 11, color: 'var(--warn)', letterSpacing: '0.08em' }} title="Unlocked only by a confirmed Clear / Reset input">LOCKED TO LANDING TIME {formatUtc(lock.landingMs)}</span>}
    </div>
    <div className="glass tl-bar" style={{ ...bar, right }}>
      <div className="tl-track">
        {winPct && winPct.width > 0 && <div className="task-window" style={{ left: `${winPct.left}%`, width: `${winPct.width}%` }} />}
        {nowInRange && <div className="now-line" style={{ left: `${((nowMs - min) / span) * 100}%` }} />}
        <input
          // Whole-second grid inside the range, so keyboard steps move by exactly 1 s from any whole-second time
          // (the load-time range ends carry milliseconds).
          className="tl-range" type="range" min={Math.ceil(min / 1000) * 1000} max={Math.floor(max / 1000) * 1000} step={1000} value={t} disabled={locked}
          onChange={(e) => seek(Number(e.target.value))}
          aria-label="Simulation time" style={{ ['--fill' as string]: `${fillPct}%` } as React.CSSProperties}
        />
        <div className="tl-ticks" aria-hidden="true">
          {ticks(min, max).map((k, i) => <span key={i} style={{ position: 'absolute', left: `${k.pct}%`, transform: k.pct <= 0 ? 'none' : k.pct >= 100 ? 'translateX(-100%)' : 'translateX(-50%)' }}>{k.label}</span>)}
          <span />
        </div>
      </div>
      <div style={row}>
        <label className="field-label" style={{ marginBottom: 0 }}>Go to (UTC)
          <input className="hud-input mono" style={field} value={jump} placeholder="YYYY-MM-DD HH:MM:SS" disabled={locked} onChange={(e) => setJump(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') goTo() }} aria-label="Go to UTC time" />
        </label>
        <button className="hud-btn" onClick={goTo} disabled={locked}>Go</button>
        <button className="hud-btn" onClick={jumpToNow} disabled={locked} title={locked ? 'Time is locked to the calculated Landing Time' : 'Jump to the current system time (paused)'}>Now</button>
        <label className="field-label" style={{ marginBottom: 0 }}>Start
          <input className="hud-input mono" style={field} value={start ?? formatUtc(min).replace(' UTC', '')} onChange={(e) => setStart(e.target.value)} aria-label="Range start (UTC)" />
        </label>
        <label className="field-label" style={{ marginBottom: 0 }}>End
          <input className="hud-input mono" style={field} value={end ?? formatUtc(max).replace(' UTC', '')} onChange={(e) => setEnd(e.target.value)} aria-label="Range end (UTC)" />
        </label>
        <button className="hud-btn" onClick={applyRange}>Apply range</button>
      </div>
      {(inputError ?? notice) && <div role="status" style={{ color: 'var(--warn)', fontSize: 12, marginTop: 4 }}>{inputError ?? notice}</div>}
    </div>
    </>
  )
}
