import { fetchApi } from '@/api/fetchApi'

/**
 * Upload an IM chat image (P7). Mirrors the avatar flow:
 *   1. Ask our API for a short-lived presigned PUT URL (kind = chat image).
 *   2. PUT the bytes straight to object storage — plain fetch, NO bearer (the
 *      presigned signature is the auth; an Authorization header would break it).
 *   3. Return the object_key — the caller sends it as the IM message body with
 *      content_type='image'. The image is read back via resolveChatImages.
 *
 * Large non-gif images are downscaled + re-encoded to webp client-side to keep
 * uploads small; gifs upload as-is (to preserve animation), size-capped only.
 */

export const CHAT_IMAGE_ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const

/** Backend cap (10 MiB). Validate before upload to fail fast with a message. */
export const CHAT_IMAGE_MAX_SIZE = 10 * 1024 * 1024

/** Longest-edge cap for downscaled images. */
const MAX_EDGE = 1600
/** Above this, even a non-gif gets re-encoded; below it we upload as-is. */
const RECODE_SIZE_THRESHOLD = 2 * 1024 * 1024

/** Thrown with a stable `code` the caller maps to an i18n message. */
export class ChatImageError extends Error {
  code: 'invalidType' | 'tooLarge' | 'uploadError'
  constructor(code: 'invalidType' | 'tooLarge' | 'uploadError', message?: string) {
    super(message ?? code)
    this.code = code
  }
}

interface UploadUrlResponse {
  upload_url: string
  object_key: string
  expires_in: number
  headers: Record<string, string>
}

const loadImage = (blob: Blob): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new ChatImageError('invalidType'))
    }
    img.src = url
  })

/**
 * Produce the bytes + content_type to upload. Gifs pass through; other images
 * over the size/edge threshold are scaled to MAX_EDGE and re-encoded to webp.
 */
const prepareImage = async (
  file: File
): Promise<{ blob: Blob; contentType: string }> => {
  if (file.type === 'image/gif') {
    return { blob: file, contentType: 'image/gif' }
  }
  const img = await loadImage(file)
  const longest = Math.max(img.naturalWidth, img.naturalHeight)
  if (longest <= MAX_EDGE && file.size <= RECODE_SIZE_THRESHOLD) {
    return { blob: file, contentType: file.type }
  }
  const scale = Math.min(1, MAX_EDGE / longest)
  const w = Math.round(img.naturalWidth * scale)
  const h = Math.round(img.naturalHeight * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return { blob: file, contentType: file.type }
  ctx.drawImage(img, 0, 0, w, h)
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', 0.85)
  )
  if (!blob) return { blob: file, contentType: file.type }
  return { blob, contentType: 'image/webp' }
}

/** Validate, (optionally) compress, upload, and return the stored object_key. */
export const uploadChatImage = async (file: File): Promise<string> => {
  if (!CHAT_IMAGE_ALLOWED_TYPES.includes(file.type as never)) {
    throw new ChatImageError('invalidType')
  }
  const { blob, contentType } = await prepareImage(file)
  if (blob.size > CHAT_IMAGE_MAX_SIZE) {
    throw new ChatImageError('tooLarge')
  }

  let presigned: UploadUrlResponse
  try {
    presigned = await fetchApi<UploadUrlResponse>('/im/images/upload-url/', {
      method: 'POST',
      body: JSON.stringify({ content_type: contentType, size: blob.size }),
    })
  } catch (e) {
    throw new ChatImageError('uploadError', e instanceof Error ? e.message : undefined)
  }

  const put = await fetch(presigned.upload_url, {
    method: 'PUT',
    body: blob,
    headers: presigned.headers ?? { 'Content-Type': contentType },
  })
  if (!put.ok) {
    throw new ChatImageError('uploadError', `Storage upload failed (${put.status})`)
  }
  return presigned.object_key
}
