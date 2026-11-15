import { useState } from 'react'
import { useTime, CLOCK_CONFIG } from '../state/timeStore'
import { formatUtc, parseUtcInput } from '../time/clock'

// Time controls (step 16). v0.7 section 8: UTC time, play/pause and speed at the top left; the slider, exact jump and
// range fields along the bottom. Every action goes through the store, which refuses changes while a calculation lock
// is active; disabling the controls is only a visual hint. All times are UTC; typed times are parsed strictly.
const bar: React.CSSProperties = { position: 'fixed', bottom: 0, left: 0, right: 0, padding: '8px 12px', color: '#fff', background: 'rgba(0,0,0,0.65)', font: '13px system-ui, sans-serif' }
const corner: React.CSSProperties = { position: 'fixed', top: 12, left: 12, padding: '6px 10px', color: '#fff', background: 'rgba(0,0,0,0.65)', font: '13px system-ui, sans-serif', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', maxWidth: 'calc(100vw - 24px)' }
const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }
const field: React.CSSProperties = { width: 190, fontFamily: 'ui-monospace, monospace' }

export default function Timeline({ right = 0 }: { right?: number }) {
  const { t, min, max, playing, rate, lock, notice, togglePlay, setRate, seek, setRange } = useTime()
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

  return (
    <>
    <div style={{ ...corner, maxWidth: `calc(100vw - ${24 + right}px)` }}>
      <strong aria-label="Simulation time (UTC)">{formatUtc(t)}</strong>
      <button onClick={togglePlay} disabled={locked} aria-label={playing ? 'Pause' : 'Play'}>{playing ? 'Pause' : 'Play'}</button>
      <label>Speed{' '}
        <select value={rate} onChange={(e) => setRate(Number(e.target.value))} aria-label="Playback speed">
          {CLOCK_CONFIG.playbackSpeeds.map((r) => <option key={r} value={r}>{r}x</option>)}
        </select>
      </label>
      {locked && <span title="Unlocked only by a confirmed Clear / Reset input">Locked to Landing Time {formatUtc(lock.landingMs)}</span>}
    </div>
    <div style={{ ...bar, right }}>
      <input
        // Whole-second grid inside the range, so keyboard steps move by exactly 1 s from any whole-second time
        // (the load-time range ends carry milliseconds).
        type="range" min={Math.ceil(min / 1000) * 1000} max={Math.floor(max / 1000) * 1000} step={1000} value={t} disabled={locked}
        onChange={(e) => seek(Number(e.target.value))}
        aria-label="Simulation time" style={{ width: '100%' }}
      />
      <div style={row}>
        <label>Go to (UTC){' '}
          <input style={field} value={jump} placeholder="YYYY-MM-DD HH:MM:SS" disabled={locked} onChange={(e) => setJump(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') goTo() }} aria-label="Go to UTC time" />
        </label>
        <button onClick={goTo} disabled={locked}>Go</button>
        <label>Start{' '}
          <input style={field} value={start ?? formatUtc(min).replace(' UTC', '')} onChange={(e) => setStart(e.target.value)} aria-label="Range start (UTC)" />
        </label>
        <label>End{' '}
          <input style={field} value={end ?? formatUtc(max).replace(' UTC', '')} onChange={(e) => setEnd(e.target.value)} aria-label="Range end (UTC)" />
        </label>
        <button onClick={applyRange}>Apply range</button>
      </div>
      {(inputError ?? notice) && <div role="status" style={{ color: '#ffd27a' }}>{inputError ?? notice}</div>}
    </div>
    </>
  )
}
