/**
 * Whether the browser tab is hidden (`document.visibilityState === 'hidden'`),
 * re-rendering when it changes.
 */

import { useSyncExternalStore } from 'react'

function subscribe(onChange: () => void): () => void {
  if (typeof document === 'undefined') return () => {}
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

export function useDocumentHidden(): boolean {
  return useSyncExternalStore(subscribe, isHidden, () => false)
}
