import { fetchApi } from '@/api/fetchApi'

/**
 * Upload an IM file attachment (P7-b). Mirrors the image flow but for any file
 * type: presigned PUT → return {key, name, size}. The caller sends an IM message
 * with content_type='file' and body = JSON.stringify(result); it is read back
 * via resolveChatImages (the resolve endpoint is content-agnostic).
 */

/** Backend cap (50 MiB). Validate before upload to fail fast. */
export const CHAT_FILE_MAX_SIZE = 50 * 1024 * 1024

export interface ChatFileMeta {
  /** Object storage key (carried in the message body). */
  key: string
  /** Original filename (shown in the file card). */
  name: string
  /** Byte size (shown in the file card). */
  size: number
}

export class ChatFileError extends Error {
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

export const uploadChatFile = async (file: File): Promise<ChatFileMeta> => {
  if (file.size > CHAT_FILE_MAX_SIZE) {
    throw new ChatFileError('tooLarge')
  }
  const contentType = file.type || 'application/octet-stream'

  let presigned: UploadUrlResponse
  try {
    presigned = await fetchApi<UploadUrlResponse>('/im/files/upload-url/', {
      method: 'POST',
      body: JSON.stringify({
        content_type: contentType,
        size: file.size,
        filename: file.name,
      }),
    })
  } catch (e) {
    throw new ChatFileError(
      'uploadError',
      e instanceof Error ? e.message : undefined
    )
  }

  const put = await fetch(presigned.upload_url, {
    method: 'PUT',
    body: file,
    headers: presigned.headers ?? { 'Content-Type': contentType },
  })
  if (!put.ok) {
    throw new ChatFileError(
      'uploadError',
      `Storage upload failed (${put.status})`
    )
  }
  return { key: presigned.object_key, name: file.name, size: file.size }
}
