/**
 * D5 §12.6/§14: the old `/work?view=…` and `/work?task=…` links still circulate, and
 * an old task link must land on the read-only history notice rather than opening or
 * creating a new task. Only `/work` itself is treated as legacy - a `task` or `view`
 * parameter on a newer route belongs to that route and must not be reinterpreted
 * (the isolation check D5 §13.10 asks for).
 */
export const legacyWorkRedirect = (
  location: string,
  params: URLSearchParams
): string | null => {
  if (location !== '/work') return null
  const legacyTask = params.get('task')
  if (legacyTask) {
    return `/work/archive?legacyTask=${encodeURIComponent(legacyTask)}`
  }
  const legacyView = params.get('view')
  if (!legacyView) return null
  if (legacyView === 'new') return '/work/new'
  if (legacyView === 'history') return '/work/archive'
  if (
    ['pending', 'running', 'awaiting_acceptance', 'completed', 'all'].includes(
      legacyView
    )
  )
    return `/work/items?view=${legacyView}`
  return '/work/items'
}
