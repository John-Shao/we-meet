import { fetchApi } from '@/api/fetchApi'

interface UploadUrlResponse {
  upload_url: string
  object_key: string
  expires_in: number
  headers?: Record<string, string>
}

interface GroupAvatarResponse {
  cid: string
  avatar_url: string
}

/** Resolve private custom group avatars to short-lived display URLs. */
export const resolveGroupAvatars = (
  cids: string[]
): Promise<Record<string, string>> =>
  fetchApi<Record<string, string>>('/im/conversations/avatars/resolve/', {
    method: 'POST',
    body: JSON.stringify({ cids }),
  })

/** Upload a prepared JPEG and make it the group's avatar. */
export const uploadGroupAvatar = async (
  cid: string,
  blob: Blob
): Promise<GroupAvatarResponse> => {
  const contentType = 'image/jpeg'
  const presigned = await fetchApi<UploadUrlResponse>(
    '/im/conversations/avatar-upload-url/',
    {
      method: 'POST',
      body: JSON.stringify({ cid, content_type: contentType, size: blob.size }),
    }
  )
  const put = await fetch(presigned.upload_url, {
    method: 'PUT',
    body: blob,
    headers: presigned.headers ?? { 'Content-Type': contentType },
  })
  if (!put.ok) throw new Error(`Storage upload failed (${put.status})`)
  return fetchApi<GroupAvatarResponse>('/im/conversations/avatar/', {
    method: 'PATCH',
    body: JSON.stringify({ cid, object_key: presigned.object_key }),
  })
}

/** Restore the generated member mosaic. */
export const removeGroupAvatar = (cid: string): Promise<GroupAvatarResponse> =>
  fetchApi<GroupAvatarResponse>('/im/conversations/avatar/', {
    method: 'PATCH',
    body: JSON.stringify({ cid, object_key: '' }),
  })
