import { useEffect, useRef, useState } from 'react'
import type { DetailSnapshot, SnapshotPoint } from '../sim/snapshot'
import { explain, MOON_TEXTURE_REF } from './explain'
import type { ExplainKey, ExplainRef } from './explain'
import { isUnverified, lookup, safeHref } from './sources'

const ROLE: Record<ExplainRef['role'], string> = {
  'source-value': 'Source value', derived: 'Derived', assumption: 'Project assumption', model: 'Model', dataset: 'Dataset', 'display-only': 'Display only (not used in any calculation)',
}

/** One source, assumption or model line. Text from the register is rendered as text; only http(s) URLs become links. */
export function RefLine({ r }: { r: ExplainRef }) {
  const e = lookup(r.id)
  const href = safeHref(e?.url)
  const unverified = e ? isUnverified(e) : false
  return (
    <li style={{ marginBottom: 3 }}>
      <code>{r.id}</code> <span style={{ fontSize: 11, border: '1px solid #666', borderRadius: 3, padding: '0 4px' }}>{ROLE[r.role]}</span>
      {unverified && <span style={{ fontSize: 11, border: '1px solid #d9a441', color: '#f2d27a', borderRadius: 3, padding: '0 4px', marginLeft: 4 }}>Unverified ({e!.verification})</span>}
      {!e && <span style={{ fontSize: 11, color: '#f2d27a', marginLeft: 4 }}> (not in the source register)</span>}
      {e && <div style={{ fontSize: 12, opacity: 0.9 }}>{e.title.slice(0, 300)}{e.product ? ` · ${e.product.slice(0, 120)}` : ''}</div>}
      {r.note && <div style={{ fontSize: 12, opacity: 0.8 }}>{r.note}</div>}
      {href && <div style={{ fontSize: 12 }}><a href={href} target="_blank" rel="noopener noreferrer">{href}</a></div>}
    </li>
  )
}

/** "Explain" button and its panel for one number. Keyboard: Enter/Space toggles, Escape closes and returns focus. */
export function Explain({ k, snap, point }: { k: ExplainKey; snap: DetailSnapshot; point: SnapshotPoint }) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => { if (open) panel.current?.focus() }, [open])
  const e = open ? explain(k, snap, point) : null
  const section = (title: string, items: string[]) => items.length > 0 && <><div style={{ fontWeight: 600, marginTop: 6 }}>{title}</div><ul style={{ margin: '2px 0', paddingLeft: 18 }}>{items.map((t, i) => <li key={i}>{t}</li>)}</ul></>
  return (
    <>
      <button ref={btn} className="hud-btn" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`Explain: ${explain(k, snap, point).title}`} style={{ fontSize: 11, padding: '0 6px', marginLeft: 6 }}>Explain</button>
      {e && (
        <div ref={panel} tabIndex={-1} role="region" aria-label={`Explanation: ${e.title}`} data-testid="explain-panel"
          onKeyDown={(ev) => { if (ev.key === 'Escape') { setOpen(false); btn.current?.focus() } }}
          style={{ gridColumn: '1 / -1', background: '#14181f', border: '1px solid #445', borderRadius: 4, padding: 8, margin: '4px 0', fontSize: 12, lineHeight: 1.45 }}>
          <div style={{ fontWeight: 700 }}>{e.title}</div>
          <div style={{ marginTop: 4 }}>Formula: <code>{e.formula}</code></div>
          {section('Variables', e.variables)}
          <div style={{ marginTop: 4 }}>Units: {e.units}</div>
          {section('Window and boundary rules', e.rules)}
          {section('Resolution and uncertainty', e.resolution)}
          {section('Limits', e.limits)}
          {section('Model and data versions of this snapshot', e.versions)}
          <div style={{ fontWeight: 600, marginTop: 6 }}>Sources, assumptions and models</div>
          <ul style={{ margin: '2px 0', paddingLeft: 18, listStyle: 'none' }}>{e.refs.map((r) => <RefLine key={r.id} r={r} />)}</ul>
          <button className="hud-btn" onClick={() => { setOpen(false); btn.current?.focus() }} style={{ fontSize: 11 }}>Close explanation</button>
        </div>
      )}
    </>
  )
}

export { MOON_TEXTURE_REF }
