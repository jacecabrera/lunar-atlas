import { useId, useState } from 'react'
import { formatUtc } from '../time/clock'
import { parseNumberText, parseUtcText } from './formModel'

// Text fields that keep what the user typed (empty, '-', '1.') while the parsed value goes to the store.
// '' means not filled (null); 0 is a real value; unparsable text becomes NaN so validation can name the problem.
const same = (a: number | null, b: number | null) => a === b || (Number.isNaN(a) && Number.isNaN(b))

type Props = { label: string; unit?: string; value: number | null; onValue: (v: number | null) => void; error?: string | null; help?: string; placeholder?: string; showError: boolean }

function useSyncedText(value: number | null, parse: (t: string) => number | null, format: (v: number) => string) {
  const shown = (v: number | null) => (v === null || Number.isNaN(v) ? '' : format(v))
  const [text, setText] = useState(shown(value))
  const [seen, setSeen] = useState(value)
  // An outside change (reset, Clear) that the current text does not express replaces the text (adjusted during
  // render, React's recommended pattern instead of an effect).
  if (!same(seen, value)) {
    setSeen(value)
    if (!same(parse(text), value)) setText(shown(value))
  }
  return [text, setText] as const
}

function Field({ label, unit, error, help, showError, children, id }: Omit<Props, 'value' | 'onValue'> & { children: React.ReactNode; id: string }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <label htmlFor={id} style={{ display: 'block', fontSize: 12, opacity: 0.85 }}>{label}{unit ? ` (${unit})` : ''}</label>
      {children}
      {help && <div style={{ fontSize: 11, opacity: 0.65 }}>{help}</div>}
      {showError && error && <div id={`${id}-err`} role="alert" style={{ fontSize: 12, color: '#ffb4a8' }}>Error: {error}</div>}
    </div>
  )
}

const input: React.CSSProperties = { width: '100%', boxSizing: 'border-box', fontFamily: 'ui-monospace, monospace' }

export function NumberField(p: Props) {
  const id = useId()
  const [text, setText] = useSyncedText(p.value, parseNumberText, String)
  return (
    <Field {...p} id={id}>
      <input id={id} style={input} inputMode="decimal" value={text} placeholder={p.placeholder} aria-invalid={!!(p.showError && p.error)} aria-describedby={p.error ? `${id}-err` : undefined}
        onChange={(e) => { setText(e.target.value); const v = parseNumberText(e.target.value); if (!same(v, p.value)) p.onValue(v) }} />
    </Field>
  )
}

export function UtcField(p: Props) {
  const id = useId()
  const fmt = (v: number) => formatUtc(v).replace(' UTC', '')
  const [text, setText] = useSyncedText(p.value, parseUtcText, fmt)
  return (
    <Field {...p} id={id}>
      <input id={id} style={input} value={text} placeholder={p.placeholder ?? 'YYYY-MM-DD HH:MM:SS'} aria-invalid={!!(p.showError && p.error)} aria-describedby={p.error ? `${id}-err` : undefined}
        onChange={(e) => { setText(e.target.value); const v = parseUtcText(e.target.value); if (!same(v, p.value)) p.onValue(v) }} />
    </Field>
  )
}
