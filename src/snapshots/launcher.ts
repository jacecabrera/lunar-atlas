// The home page's real wiring of launchDetails: stores, IndexedDB, window.open. Also the UI state of the button.
import { create } from 'zustand'
import { useMission } from '../state/missionStore'
import { useCustomSites, MAX_CUSTOM_SITES } from '../state/customSites'
import { inputOfDraft } from '../scene/routeModel'
import { launchDetails, detailsUrl } from './launch'
import type { LaunchOutcome } from './launch'
import { indexedDbBackend } from './storage'

type LaunchState =
  | { phase: 'idle' }
  | { phase: 'saving' }
  | { phase: 'done'; outcome: Extract<LaunchOutcome, { ok: true }> }
  | { phase: 'failed'; error: string; url: string; opened: boolean }

export const useDetailsLaunch = create<{ state: LaunchState; click: () => void; dismiss: () => void }>((set, get) => ({
  state: { phase: 'idle' },
  dismiss: () => set({ state: { phase: 'idle' } }),
  click: () => {
    if (get().state.phase === 'saving') return // one snapshot per click, not per double click
    set({ state: { phase: 'saving' } })
    const p = launchDetails({
      open: (url) => window.open(url, '_blank'),
      backend: indexedDbBackend(),
      detailsUrl,
      args: () => {
        const m = useMission.getState()
        return { task: m.task, input: inputOfDraft(m.draft), settings: m.settings, customs: useCustomSites.getState().sites, maxCustom: MAX_CUSTOM_SITES }
      },
    })
    p.then((o) => set({ state: o.ok ? { phase: 'done', outcome: o } : { phase: 'failed', error: o.error, url: o.url, opened: o.opened } }))
  },
}))
