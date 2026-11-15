// Test helper: a terrain store that reads the published files from disk (Node tests only).
import { createSiteTerrainStore } from '../siteTerrain'

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
