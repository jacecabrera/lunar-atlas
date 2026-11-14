import { create } from 'zustand'

type AppState = {
  exaggerate: boolean
  toggleExaggerate: () => void
  focus: 'earth' | 'moon'
  toggleFocus: () => void
}

export const useApp = create<AppState>((set) => ({
  exaggerate: true,
  toggleExaggerate: () => set((s) => ({ exaggerate: !s.exaggerate })),
  focus: 'earth',
  toggleFocus: () => set((s) => ({ focus: s.focus === 'earth' ? 'moon' : 'earth' })),
}))