import { useEffect, useState } from 'react'
import { SRGBColorSpace, TextureLoader } from 'three'
import type { Texture } from 'three'
import { useApp } from '../state/appStore'

/**
 * Load a texture without suspending or throwing: null until loaded, and null with a readable scene message when the
 * request fails. Nothing is thrown into React, so R3F (which reports caught render errors through reportError) never
 * sees an error for a missing texture. The body is then drawn untextured in the same pose. Visual only.
 */
export function useOptionalTexture(url: string, label: string): Texture | null {
  const [tex, setTex] = useState<Texture | null>(null)
  useEffect(() => {
    let alive = true
    let loaded: Texture | null = null
    new TextureLoader().load(
      url,
      (t) => { t.colorSpace = SRGBColorSpace; loaded = t; if (alive) setTex(t); else t.dispose() },
      undefined,
      () => { if (alive) useApp.getState().reportSceneIssue(`${label} could not be loaded (${url}); showing an untextured body`) },
    )
    return () => { alive = false; loaded?.dispose() }
  }, [url, label])
  return tex
}
