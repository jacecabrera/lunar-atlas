// Snapshot storage (step 21): IndexedDB, own database, separate from the task result cache (which is in memory only).
//
// Why IndexedDB: a snapshot holds the full statistics and horizon of up to 12 points (hundreds of kB), which does not
// fit localStorage's ~5 MB budget comfortably and is synchronous; sessionStorage is per tab and would not reach the
// details tab; the URL carries only the snapshot ID. Each record is the validated JSON text, so what is read back is an
// independent copy that has passed the same validation as on save. Nothing is ever evicted automatically.
// This is per browser and per origin: a link does not work on another device or browser profile.
import { parseSnapshot, serializeSnapshot, SNAPSHOT_ID_PATTERN } from '../sim/snapshot'
import type { DetailSnapshot } from '../sim/snapshot'

export const SNAPSHOT_DB_NAME = 'lunar-navigator'
export const SNAPSHOT_STORE = 'detail-snapshots'

export type StorageErrorKind = 'unsupported' | 'disabled' | 'quota' | 'failed'
export class SnapshotStorageError extends Error {
  readonly kind: StorageErrorKind
  constructor(kind: StorageErrorKind, message: string) { super(message); this.name = 'SnapshotStorageError'; this.kind = kind }
}

export type SnapshotRecord = { id: string; schemaVersion: number; createdAtMs: number; text: string }
export interface SnapshotBackend {
  put(record: SnapshotRecord): Promise<void>
  get(id: string): Promise<SnapshotRecord | undefined>
}

const MESSAGES: Record<StorageErrorKind, string> = {
  unsupported: 'This browser does not support IndexedDB, so details cannot be saved or opened',
  disabled: 'Browser storage is disabled or blocked (for example private browsing or a site-data setting), so details cannot be saved or opened',
  quota: 'The browser storage is full, so the details could not be saved',
  failed: 'The browser storage reported an error',
}

function classify(e: unknown): SnapshotStorageError {
  if (e instanceof SnapshotStorageError) return e
  const name = (e as { name?: string } | null)?.name ?? ''
  const detail = e instanceof Error && e.message ? `: ${e.message}` : ''
  if (name === 'QuotaExceededError') return new SnapshotStorageError('quota', MESSAGES.quota)
  if (name === 'SecurityError' || name === 'InvalidStateError' || name === 'NotAllowedError') return new SnapshotStorageError('disabled', MESSAGES.disabled)
  return new SnapshotStorageError('failed', `${MESSAGES.failed}${detail}`)
}

/** IndexedDB backend. A connection is opened per operation and closed after it, so it never blocks another tab. */
export function indexedDbBackend(factory: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory }).indexedDB): SnapshotBackend {
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    if (!factory) { reject(new SnapshotStorageError('unsupported', MESSAGES.unsupported)); return }
    let req: IDBOpenDBRequest
    try { req = factory.open(SNAPSHOT_DB_NAME, 1) } catch (e) { reject(classify(e)); return }
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(SNAPSHOT_STORE)) req.result.createObjectStore(SNAPSHOT_STORE, { keyPath: 'id' }) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(classify(req.error))
    req.onblocked = () => reject(new SnapshotStorageError('failed', 'The snapshot database is blocked by another tab; close other tabs of this app and try again'))
  })
  const run = async <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open()
    try {
      return await new Promise<T>((resolve, reject) => {
        let tx: IDBTransaction
        try { tx = db.transaction(SNAPSHOT_STORE, mode) } catch (e) { reject(classify(e)); return }
        let result: T
        const req = f(tx.objectStore(SNAPSHOT_STORE))
        req.onsuccess = () => { result = req.result }
        req.onerror = () => reject(classify(req.error))
        tx.oncomplete = () => resolve(result)
        tx.onabort = () => reject(classify(tx.error))
      })
    } finally { db.close() }
  }
  return {
    put: (record) => run('readwrite', (s) => s.put(record)).then(() => undefined),
    get: (id) => run<SnapshotRecord | undefined>('readonly', (s) => s.get(id)),
  }
}

/** In-memory backend for tests and for checking behaviour without a browser. */
export function memoryBackend(opts: { failPut?: StorageErrorKind; failGet?: StorageErrorKind } = {}): SnapshotBackend & { records: Map<string, SnapshotRecord> } {
  const records = new Map<string, SnapshotRecord>()
  return {
    records,
    async put(r) { if (opts.failPut) throw new SnapshotStorageError(opts.failPut, MESSAGES[opts.failPut]); records.set(r.id, structuredClone(r)) },
    async get(id) { if (opts.failGet) throw new SnapshotStorageError(opts.failGet, MESSAGES[opts.failGet]); const r = records.get(id); return r ? structuredClone(r) : undefined },
  }
}

/** Validate, serialise, write, then read back and compare, so "saved" means a later load will succeed. Throws SnapshotStorageError or Error. */
export async function saveSnapshot(backend: SnapshotBackend, snapshot: DetailSnapshot): Promise<void> {
  const text = serializeSnapshot(snapshot) // throws for an invalid snapshot; nothing is written
  try {
    await backend.put({ id: snapshot.snapshotId, schemaVersion: snapshot.schemaVersion, createdAtMs: snapshot.createdAtMs, text })
    const back = await backend.get(snapshot.snapshotId)
    if (!back || back.text !== text) throw new SnapshotStorageError('failed', 'The saved snapshot could not be read back intact')
  } catch (e) { throw classify(e) }
}

export type LoadResult =
  | { status: 'ok'; snapshot: DetailSnapshot }
  | { status: 'missing' }
  | { status: 'bad-id' }
  | { status: 'corrupt'; error: string }
  | { status: 'unsupported-version'; error: string }
  | { status: 'storage-error'; kind: StorageErrorKind; message: string }

export async function loadSnapshot(backend: SnapshotBackend, id: string | null): Promise<LoadResult> {
  if (!id || !SNAPSHOT_ID_PATTERN.test(id)) return { status: 'bad-id' }
  let rec: SnapshotRecord | undefined
  try { rec = await backend.get(id) } catch (e) { const c = classify(e); return { status: 'storage-error', kind: c.kind, message: c.message } }
  if (!rec) return { status: 'missing' }
  if (typeof rec.text !== 'string') return { status: 'corrupt', error: 'The stored record has no snapshot text' }
  const p = parseSnapshot(rec.text)
  if (!p.ok) return p.kind === 'unsupported-version' ? { status: 'unsupported-version', error: p.error } : { status: 'corrupt', error: p.error }
  if (p.snapshot.snapshotId !== id) return { status: 'corrupt', error: 'The stored snapshot does not match its ID' }
  return { status: 'ok', snapshot: p.snapshot }
}

export type WaitOptions = {
  /** Total time to wait for a snapshot that is not there yet (the home page may still be saving it). */
  timeoutMs?: number
  intervalMs?: number
  isCancelled?: () => boolean
  /** True when the opener reported that saving failed (stops waiting at once). */
  failed?: () => string | null
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/**
 * Load a snapshot, waiting while it is missing: a details tab opened at click time may run before the home page has
 * finished saving. Any other outcome (found, corrupt, unsupported version, storage error) is returned at once. After the
 * timeout the result stays 'missing' (the caller offers Retry); there is no infinite loading state.
 */
export async function waitForSnapshot(backend: SnapshotBackend, id: string | null, o: WaitOptions = {}): Promise<LoadResult & { waitedMs: number; saveFailure?: string }> {
  const now = o.now ?? Date.now
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)))
  const timeoutMs = o.timeoutMs ?? 15_000, intervalMs = o.intervalMs ?? 300
  const start = now()
  for (;;) {
    const r = await loadSnapshot(backend, id)
    const waited = now() - start
    if (r.status !== 'missing') return { ...r, waitedMs: waited }
    const f = o.failed?.()
    if (f) return { status: 'missing', waitedMs: waited, saveFailure: f }
    if (waited >= timeoutMs || o.isCancelled?.()) return { status: 'missing', waitedMs: waited }
    await sleep(intervalMs)
  }
}
