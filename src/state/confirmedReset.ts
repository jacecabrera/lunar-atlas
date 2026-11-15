// What a confirmed Clear / Reset input does (step 23 adds the confirmation dialog and anything else it clears).
// Cancelling the dialog must not call this. A settings reset (resetSettings) is not this and does not unlock the clock.
// Detail-page snapshots (step 21) are separate and are not touched.
import { missionTasks } from './missionTasks'
import { useMission } from './missionStore'
import { useTime } from './timeStore'

export function applyConfirmedReset() {
  missionTasks().resetConfirmed() // stop the running request; it can no longer write back
  useMission.getState().resetInputConfirmed()
  useTime.getState().resetTimeConfirmed()
}
