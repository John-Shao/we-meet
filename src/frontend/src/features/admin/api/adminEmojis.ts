import { fetchApi } from '@/api/fetchApi'

export interface AdminEmoji {
  id: string
  name: string
  key: string
  url: string
  width: number
  height: number
  animated: boolean
  sort_order: number
  active: boolean
}
interface UploadUrl {
  upload_url: string
  object_key: string
  headers: Record<string, string>
}

export const listAdminEmojis = () => fetchApi<AdminEmoji[]>('/admin/im-emojis/')
export const uploadAdminEmoji = async (file: File, name: string) => {
  if (file.size > 2 * 1024 * 1024) throw new Error('图片不能超过 2 MB')
  const signed = await fetchApi<UploadUrl>('/admin/im-emojis/upload-url/', {
    method: 'POST',
    body: JSON.stringify({ content_type: file.type, size: file.size }),
  })
  const result = await fetch(signed.upload_url, {
    method: 'PUT',
    headers: signed.headers,
    body: file,
  })
  if (!result.ok) throw new Error('上传失败')
  return fetchApi<AdminEmoji>('/admin/im-emojis/', {
    method: 'POST',
    body: JSON.stringify({ name, object_key: signed.object_key }),
  })
}
export const updateAdminEmoji = (
  id: string,
  patch: Partial<{ name: string; sort_order: number; active: boolean }>
) =>
  fetchApi<AdminEmoji>(`/admin/im-emojis/${id}/`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
export const disableAdminEmoji = (id: string) =>
  fetchApi<void>(`/admin/im-emojis/${id}/`, { method: 'DELETE' })
