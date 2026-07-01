import { fetchApi } from '@/api/fetchApi'

/**
 * Upload an IM voice clip (P7-i). Mirrors the file flow but targets the
 * dedicated voice bucket (`audio/` prefix): presigned PUT → return the object
 * key. The caller sends an IM message with content_type='voice' and body =
 * JSON.stringify({ key, duration }); it is read back via resolveChatImages
 * (the resolve endpoint routes the `audio/` prefix to the voice bucket).
 */

/** Backend cap (20 MiB). */
export const CHAT_AUDIO_MAX_SIZE = 20 * 1024 * 1024

export class ChatVoiceError extends Error {
  code: 'tooLarge' | 'uploadError'
  constructor(code: 'tooLarge' | 'uploadError', message?: string) {
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

export const uploadChatVoice = async (blob: Blob): Promise<string> => {
  if (blob.size > CHAT_AUDIO_MAX_SIZE) {
    throw new ChatVoiceError('tooLarge')
  }
  const contentType = blob.type || 'audio/webm'
  const ext = contentType.includes('mp4')
    ? 'mp4'
    : contentType.includes('ogg')
      ? 'ogg'
      : 'webm'

  let presigned: UploadUrlResponse
  try {
    presigned = await fetchApi<UploadUrlResponse>('/im/audio/upload-url/', {
      method: 'POST',
      body: JSON.stringify({
        content_type: contentType,
        size: blob.size,
        filename: `voice.${ext}`,
      }),
    })
  } catch (e) {
    throw new ChatVoiceError(
      'uploadError',
      e instanceof Error ? e.message : undefined
    )
  }

  const put = await fetch(presigned.upload_url, {
    method: 'PUT',
    body: blob,
    headers: presigned.headers ?? { 'Content-Type': contentType },
  })
  if (!put.ok) {
    throw new ChatVoiceError(
      'uploadError',
      `Storage upload failed (${put.status})`
    )
  }
  return presigned.object_key
}
