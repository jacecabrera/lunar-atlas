import { create } from 'zustand'

// Display-only state. Nothing here feeds a calculation.
type AppState = {
  focus: 'earth' | 'moon'
  toggleFocus: () => void
  /** Display only: draw the Earth and Moon 10x larger (true scale by default). Positions, distances and every calculation stay true. */
  exaggerate: boolean
  toggleExaggerate: () => void
  /** Scene resources that failed to load (e.g. a texture); the scene degrades, the rest of the app keeps working. */
  sceneIssues: string[]
  reportSceneIssue: (message: string) => void
  /** Right sidebar shown (the canvas and the bottom time bar use the remaining width). */
  sidebarOpen: boolean
  toggleSidebar: () => void
}

/** Factor of the optional size exaggeration of the Earth and Moon. */
export const SIZE_EXAGGERATION = 10

/** Sidebar width in CSS pixels. */
export const SIDEBAR_WIDTH = 380

export const useApp = create<AppState>((set) => ({
  focus: 'earth',
  toggleFocus: () => set((s) => ({ focus: s.focus === 'earth' ? 'moon' : 'earth' })),
  exaggerate: false,
  toggleExaggerate: () => set((s) => ({ exaggerate: !s.exaggerate })),
  sceneIssues: [],
  reportSceneIssue: (message) => set((s) => (s.sceneIssues.includes(message) ? s : { sceneIssues: [...s.sceneIssues, message] })),
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
}))
