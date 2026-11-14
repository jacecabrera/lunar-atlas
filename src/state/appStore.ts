import { create } from 'zustand'

type AppState = {
  exaggerate: boolean
  toggleExaggerate: () => void
}

export const useApp = create<AppState>((set) => ({
  exaggerate: true,
  toggleExaggerate: () => set((s) => ({ exaggerate: !s.exaggerate })),
}))