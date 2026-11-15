// What a confirmed Clear / Reset input does (step 23 adds the confirmation dialog and anything else it clears).
// Cancelling the dialog must not call this. A settings reset (resetSettings) is not this and does not unlock the clock.
// Detail-page snapshots (step 21) are separate and are not touched.
import { missionTasks } from './missionTasks'
import { useMission } from './missionStore'
import { useTime } from './timeStore'
import { useCustomSites } from './customSites'
import { useRoutes } from './routesStore'

export function applyConfirmedReset() {
  missionTasks().resetConfirmed() // stop the running request; it can no longer write back
  useMission.getState().resetInputConfirmed()
  useMission.getState().resetSettings() // v0.7 section 8: a confirmed Clear also restores the advanced settings
  useTime.getState().resetTimeConfirmed()
  useCustomSites.getState().resetConfirmed()
  useRoutes.getState().resetConfirmed() // home-page routes follow their data; the demo route is switched off (the user can enable it again)
}
