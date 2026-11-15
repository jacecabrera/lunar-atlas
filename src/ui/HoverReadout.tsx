import { useCustomSites } from '../state/customSites'

// Moon coordinate under the pointer (sphere pick on the textured mesh). Display only; the decimals are not a positioning
// accuracy and the sphere is not a terrain model.
export default function HoverReadout({ right }: { right: number }) {
  const hover = useCustomSites((s) => s.hover)
  if (!hover) return null
  return (
    <div aria-live="off" data-testid="moon-hover" style={{ position: 'fixed', bottom: 84, right: right + 12, padding: '4px 8px', color: '#fff', background: 'rgba(0,0,0,0.65)', font: '12px ui-monospace, monospace' }}>
      Moon {hover.lat.toFixed(3)}°, {hover.lon.toFixed(3)}° (click to use; sphere pick)
    </div>
  )
}
