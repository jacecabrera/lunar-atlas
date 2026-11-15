// Minimal runtime source index for the details page (step 22). The register stays in sources.md: this module reads that
// file at build time (`?raw`) and extracts the entries by ID, so there is one place to maintain. It does not read
// docs/reference. Text from the register is only ever rendered as text; a link is made only for http(s) URLs.
import registerText from '../../sources.md?raw'

export type RegisterEntry = {
  id: string
  /** 'source' for SRC-/REQ- rows, 'assumption' for ASM- rows. */
  type: 'source' | 'assumption'
  title: string
  url: string | null
  product: string | null
  verification: string | null
  scope: string | null
}

const ROW = /^\|\s*`((?:SRC|REQ|ASM)-[A-Z0-9-]+)`\s*\|(.*)\|\s*$/

/** Parse the register tables of sources.md (SRC-/REQ- rows have 7 columns, ASM- rows 3: ID, statement, where). */
export function parseRegister(text: string): Map<string, RegisterEntry> {
  const out = new Map<string, RegisterEntry>()
  for (const line of text.split('\n')) {
    const m = ROW.exec(line)
    if (!m) continue
    const id = m[1]
    const cells = m[2].split(' | ').map((c) => c.trim())
    if (id.startsWith('ASM-')) {
      // A statement may itself contain pipes (|UT1 - UTC|), so the last cell is "where" and everything before it the statement.
      const where = cells.length > 1 ? cells[cells.length - 1] : null
      const statement = (cells.length > 1 ? cells.slice(0, -1) : cells).join(' | ')
      out.set(id, { id, type: 'assumption', title: statement, url: null, product: null, verification: null, scope: where ? `Used in ${where.replace(/`/g, '')}` : null })
    } else {
      const url = cells[1] && /^https?:\/\//.test(cells[1]) ? cells[1].split(' ')[0] : null
      out.set(id, { id, type: 'source', title: cells[0] ?? id, url, product: cells[2] ?? null, verification: cells[3] ?? null, scope: cells.slice(5).join(' | ') || null })
    }
  }
  return out
}

let cached: Map<string, RegisterEntry> | null = null
export const register = () => (cached ??= parseRegister(registerText))

export function lookup(id: string): RegisterEntry | null { return register().get(id) ?? null }

/** Only http(s) URLs become links (no javascript:, data: or relative URLs). */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null
  try { const u = new URL(url); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null } catch { return null }
}

export const UNVERIFIED = new Set(['agent-reported', 'not-verified', 'access-failed', 'metadata-only'])
/** True when the register says the source was not read in the original (so it must be shown as unverified). */
export const isUnverified = (e: RegisterEntry) => e.type === 'source' && !!e.verification && UNVERIFIED.has(e.verification)
