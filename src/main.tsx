import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { setTaskAcceptedHandler, missionTasks } from './state/missionTasks'
import { setCustomSiteScheduler } from './state/customSites'
import { useTime } from './state/timeStore'

// An accepted calculation pauses the scene clock, jumps to the Landing Time and locks it (steps 15-16).
setTaskAcceptedHandler((landingTimeMs, requestId) => useTime.getState().lockToLanding(landingTimeMs, requestId))
// Custom sites are evaluated by the same scheduler and Worker (step 19).
setCustomSiteScheduler(missionTasks)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
