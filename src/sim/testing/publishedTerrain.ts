// Test helper: a terrain store that reads the published files from disk (Node tests only).
import { createSiteTerrainStore } from '../siteTerrain'
import { createGlobalTerrainStore } from '../globalTerrain'

export function diskTerrainStore() {
  const root = decodeURIComponent(new URL('../../../public/data/terrain/v1/', import.meta.url).pathname)
  const fetcher = async (url: string) => {
    // Node's fs, imported by name so the browser-only tsconfig needs no Node type definitions.
    const fsModule = 'node:fs/promises'
    const { readFile } = (await import(/* @vite-ignore */ fsModule)) as { readFile: (p: string) => Promise<Uint8Array> }
    try {
      const b = await readFile(root + url.replace('/terrain/', ''))
      return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer }
    } catch { return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) } }
  }
  return createSiteTerrainStore({ baseUrl: '/terrain/', fetcher })
}

/** A global terrain store reading the published tiles from disk (Node tests only). */
export function diskGlobalStore(opts: { onFetch?: (url: string) => void; corrupt?: (url: string, bytes: Uint8Array) => Uint8Array } = {}) {
  const root = decodeURIComponent(new URL('../../../public/data/terrain/global-v1/', import.meta.url).pathname)
  const fetcher = async (url: string) => {
    opts.onFetch?.(url)
    const fsModule = 'node:fs/promises'
    const { readFile } = (await import(/* @vite-ignore */ fsModule)) as { readFile: (p: string) => Promise<Uint8Array> }
    try {
      let b: Uint8Array = new Uint8Array(await readFile(root + url.replace('/global/', '')))
      if (opts.corrupt) b = opts.corrupt(url, b)
      return { ok: true, status: 200, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer }
    } catch { return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) } }
  }
  return createGlobalTerrainStore({ baseUrl: '/global/', fetcher })
}

/** The shipped LDEM_4 preview grid as int16 metres (Node tests only). */
export async function readLdem4(): Promise<Int16Array> {
  const fsModule = 'node:fs/promises'
  const { readFile } = (await import(/* @vite-ignore */ fsModule)) as { readFile: (p: string) => Promise<Uint8Array> }
  const b = await readFile(decodeURIComponent(new URL('../../../public/data/lola/ldem_4.bin', import.meta.url).pathname))
  return new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length))
}
