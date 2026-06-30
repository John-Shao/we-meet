import { fetchApi } from '@/api/fetchApi'

/**
 * Upload a user avatar (P6-e). Three steps mirroring the mobile flow:
 *   1. Ask our API for a short-lived presigned PUT URL (kind=avatar).
 *   2. PUT the image bytes straight to object storage — plain fetch, NO bearer
 *      (the presigned signature is the auth; an extra Authorization header would
 *      break it). This is the documented exception to the fetchApi-bearer rule.
 *   3. PATCH our API to persist the object_key on the user record.
 *
 * The caller is responsible for producing the (already cropped/resized) JPEG
 * blob and for invalidating the user query afterwards.
 */

interface UploadUrlResponse {
  upload_url: string
  object_key: string
  expires_in: number
  headers: Record<string, string>
}

export const uploadAvatar = async (blob: Blob): Promise<void> => {
  const contentType = 'image/jpeg'

  const presigned = await fetchApi<UploadUrlResponse>('/users/me/upload-url/', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'avatar',
      content_type: contentType,
      size: blob.size,
    }),
  })

  const put = await fetch(presigned.upload_url, {
    method: 'PUT',
    body: blob,
    headers: presigned.headers ?? { 'Content-Type': contentType },
  })
  if (!put.ok) {
    throw new Error(`Storage upload failed (${put.status})`)
  }

  await fetchApi('/users/me/profile-image/', {
    method: 'PATCH',
    body: JSON.stringify({ kind: 'avatar', object_key: presigned.object_key }),
  })
}
