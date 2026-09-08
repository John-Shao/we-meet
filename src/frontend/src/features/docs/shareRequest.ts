const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseShareRequest(
  event: MessageEvent,
  origin: string,
  source: Window | null
) {
  if (!origin || !source || event.origin !== origin || event.source !== source)
    return null
  const data = event.data as Record<string, unknown> | null
  if (!data || typeof data.docId !== 'string' || !UUID_RE.test(data.docId))
    return null
  if (
    data.type !== 'wemeet-share-doc' &&
    data.type !== 'wemeet-invite-doc-members'
  )
    return null
  return {
    type: data.type,
    docId: data.docId,
    title: typeof data.title === 'string' ? data.title.slice(0, 255) : '',
    url: `${origin}/docs/${data.docId}/`,
    role: data.role === 'editor' ? ('editor' as const) : ('reader' as const),
    canManage: data.canManage === true,
  }
}
