/**
 * Dashboard live refresh: which portlets are kept current, and how often their
 * refresh keys may be checked.
 *
 * A portlet with an effective refresh interval subscribes its queries (change
 * detection through `/refresh-keys`, one call per tick for the page) instead
 * of refetching on a timer. This hook decides, per portlet, whether that
 * subscription runs: not while `features.refresh` is off or `manualRefresh`
 * is on, not in edit mode or while the dashboard is paused, not for a portlet
 * the viewer paused, and not while the tab is hidden for a portlet with
 * `pauseWhenHidden`. A portlet that stops subscribing keeps its data; when it
 * resumes, its first check compares against the last key seen and refetches
 * only if the data changed meanwhile.
 */

import { useCallback, useMemo } from 'react'
import type { DashboardRefreshConfig, FeaturesConfig, PortletConfig } from '../../types.js'
import { resolveEffectiveRefresh, resolveLiveRefreshSeconds } from '../../utils/freshness.js'
import { useDocumentHidden } from '../useDocumentHidden.js'

export interface UseDashboardLiveRefreshParams {
  portlets: PortletConfig[]
  dashboardRefresh?: DashboardRefreshConfig
  features: FeaturesConfig
  /** Stop every subscription (edit mode or dashboard-level pause) */
  stopped: boolean
  /** Portlets the viewer paused */
  pausedPortletIds: string[]
}

export interface DashboardLiveRefreshState {
  /** Whether any portlet on the dashboard has an effective refresh interval */
  hasRefresh: boolean
  /** The interval a portlet's subscription uses right now, or undefined when it does not subscribe */
  liveIntervalSeconds: (portletId: string) => number | undefined
}

export function useDashboardLiveRefresh({
  portlets,
  dashboardRefresh,
  features,
  stopped,
  pausedPortletIds
}: UseDashboardLiveRefreshParams): DashboardLiveRefreshState {
  const documentHidden = useDocumentHidden()

  const effective = useMemo(() => {
    const byPortlet = new Map<string, ReturnType<typeof resolveEffectiveRefresh>>()
    for (const portlet of portlets) {
      const refresh = resolveEffectiveRefresh(portlet.refresh, dashboardRefresh, features)
      if (refresh) byPortlet.set(portlet.id, refresh)
    }
    return byPortlet
  }, [portlets, dashboardRefresh, features])

  const liveIntervalSeconds = useCallback(
    (portletId: string) => resolveLiveRefreshSeconds(effective.get(portletId), {
      stopped,
      portletPaused: pausedPortletIds.includes(portletId),
      documentHidden
    }),
    [effective, stopped, pausedPortletIds, documentHidden]
  )

  return { hasRefresh: effective.size > 0, liveIntervalSeconds }
}
