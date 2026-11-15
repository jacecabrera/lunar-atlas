import { create } from 'zustand'

// Display-only state. Nothing here feeds a calculation.
type AppState = {
  focus: 'earth' | 'moon'
  toggleFocus: () => void
  /** Scene resources that failed to load (e.g. a texture); the scene degrades, the rest of the app keeps working. */
  sceneIssues: string[]
  reportSceneIssue: (message: string) => void
  /** Right sidebar shown (the canvas and the bottom time bar use the remaining width). */
  sidebarOpen: boolean
  toggleSidebar: () => void
}

/** Sidebar width in CSS pixels. */
export const SIDEBAR_WIDTH = 380

export const useApp = create<AppState>((set) => ({
  focus: 'earth',
  toggleFocus: () => set((s) => ({ focus: s.focus === 'earth' ? 'moon' : 'earth' })),
  sceneIssues: [],
  reportSceneIssue: (message) => set((s) => (s.sceneIssues.includes(message) ? s : { sceneIssues: [...s.sceneIssues, message] })),
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
}))
