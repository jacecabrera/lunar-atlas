import { useTime } from '../state/timeStore'

export default function Timeline() {
  const { t, min, max, setT } = useTime()
  return (
    <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, padding: 12, color: '#fff', background: 'rgba(0,0,0,0.6)' }}>
      <input
        type="range"
        min={min}
        max={max}
        step={60_000}
        value={t}
        onChange={(e) => setT(Number(e.target.value))}
        style={{ width: '100%' }}
      />
      <div>{new Date(t).toUTCString()}</div>
    </div>
  )
}