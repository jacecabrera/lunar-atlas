import { useMemo } from 'react'
import { useMission } from '../state/missionStore'
import { useCustomSites, MAX_CUSTOM_SITES } from '../state/customSites'
import { useRoutes } from '../state/routesStore'
import { buildRouteModel, inputOfDraft, showDemo, EMPTY_ROUTE_MODEL } from './routeModel'
import type { RouteModel } from './routeModel'

/** The model of formal routes and valid markers for the current task (recomputed only when its inputs change). */
export function useRouteModel(): RouteModel {
  const task = useMission((s) => s.task)
  const draft = useMission((s) => s.draft)
  const sites = useCustomSites((s) => s.sites)
  return useMemo(() => (task.status === 'done'
    ? buildRouteModel({ task, input: inputOfDraft(draft), customs: sites, maxCustom: MAX_CUSTOM_SITES })
    : EMPTY_ROUTE_MODEL), [task, draft, sites])
}

export function useDemoVisible(): boolean {
  const model = useRouteModel()
  const enabled = useRoutes((s) => s.demoEnabled)
  return showDemo(model, enabled)
}
