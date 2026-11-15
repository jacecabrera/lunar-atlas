import { create } from 'zustand'

// Display state of the route layer (step 20). Nothing here feeds a calculation.
//
// demoEnabled: whether the demo route may be shown when there is no drawable formal route. It starts on, so the first
// page load shows the example line; a confirmed Clear / Reset input turns it off (it must not reappear on its own) and
// the user can turn it on again. viewNonce: each "View route" press is one one-shot camera request (the camera
// controller reads it once; there is no per-frame camera grabbing).
type RoutesState = {
  demoEnabled: boolean
  setDemoEnabled: (on: boolean) => void
  viewNonce: number
  requestView: () => void
  /** Confirmed Clear / Reset input: formal routes vanish with their data; the demo is switched off. */
  resetConfirmed: () => void
}

export const useRoutes = create<RoutesState>((set) => ({
  demoEnabled: true,
  setDemoEnabled: (demoEnabled) => set({ demoEnabled }),
  viewNonce: 0,
  requestView: () => set((s) => ({ viewNonce: s.viewNonce + 1 })),
  resetConfirmed: () => set({ demoEnabled: false }),
}))
