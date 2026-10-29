/**
 * A portlet's live refresh: whether it is kept current, and how often its
 * refresh keys may be checked.
 *
 * A portlet with an effective refresh interval subscribes its queries (change
 * detection through `/refresh-keys`) instead of refetching on a timer. The
 * subscription runs except while `features.refresh` is off, in edit mode,
 * while the dashboard or the portlet is paused, and while the tab is hidden
 * for a portlet with `pauseWhenHidden`. A portlet that stops subscribing keeps
 * its data; when it resumes, its first check compares against the last key
 * seen and refetches only if the data changed meanwhile.
 *
 * Shared by the grid card and the mobile layout, so both decide alike.
 */

import { useMemo } from 'react'
import type { DashboardRefreshConfig, PortletConfig } from '../../types.js'
import { useCubeFeatures } from '../../providers/CubeFeaturesProvider.js'
import { useDashboardStore } from '../../stores/dashboardStore.js'
import { resolveEffectiveRefresh, type EffectiveRefresh } from '../../utils/freshness.js'
import { useDocumentHidden } from '../useDocumentHidden.js'

export interface PortletLiveRefresh {
  /** The portlet's refresh settings, when it has an interval */
  effectiveRefresh: EffectiveRefresh | undefined
  isDashboardPaused: boolean
  isPortletPaused: boolean
  /** The interval its subscription uses right now, or undefined when it does not subscribe */
  subscribeIntervalSeconds: number | undefined
}

export function usePortletLiveRefresh(
  portlet: Pick<PortletConfig, 'id' | 'refresh'>,
  dashboardRefresh: DashboardRefreshConfig | undefined
): PortletLiveRefresh {
  const { features } = useCubeFeatures()
  const effectiveRefresh = useMemo(
    () => resolveEffectiveRefresh(portlet.refresh, dashboardRefresh, features),
    [portlet.refresh, dashboardRefresh, features]
  )
  const isEditMode = useDashboardStore(state => state.isEditMode)
  const isDashboardPaused = useDashboardStore(state => state.isRefreshPaused)
  const isPortletPaused = useDashboardStore(state => state.pausedPortletIds.includes(portlet.id))
  const documentHidden = useDocumentHidden()
  const stopped = isEditMode || isDashboardPaused || isPortletPaused || (documentHidden && !!effectiveRefresh?.pauseWhenHidden)
  const subscribeIntervalSeconds = stopped ? undefined : effectiveRefresh?.intervalSeconds
  return { effectiveRefresh, isDashboardPaused, isPortletPaused, subscribeIntervalSeconds }
}
