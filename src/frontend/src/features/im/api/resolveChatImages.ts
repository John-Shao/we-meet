import { fetchApi } from '@/api/fetchApi'

/**
 * POST /api/v1.0/im/images/resolve/ — map chat-image object keys → short-lived
 * presigned GET URLs for rendering image messages.
 *
 * The image bucket is private; keys are carried in the IM message body
 * (content_type='image'). URLs expire (1h), so callers re-resolve on a short
 * staleTime. Keys outside the `chat/` prefix are simply absent from the result.
 */
export const resolveChatImages = (
  objectKeys: string[]
): Promise<Record<string, string>> =>
  fetchApi<Record<string, string>>('/im/images/resolve/', {
    method: 'POST',
    body: JSON.stringify({ object_keys: objectKeys }),
  })
