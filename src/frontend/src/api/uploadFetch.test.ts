import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { uploadFetch } from './uploadFetch'

class UploadRequest {
  static last: UploadRequest
  upload = {
    onprogress: null as
      | ((event: {
          lengthComputable: boolean
          loaded: number
          total: number
        }) => void)
      | null,
  }
  withCredentials = false
  status = 202
  responseText = '{"record_id":"record"}'
  onload = () => {}
  onabort = () => {}
  onerror = () => {}
  open = vi.fn()
  send = vi.fn()
  abort = vi.fn(() => this.onabort())
  setRequestHeader = vi.fn()
  getAllResponseHeaders = () => 'Content-Type: application/json\r\n'
  constructor() {
    UploadRequest.last = this
  }
}
beforeEach(() => vi.stubGlobal('XMLHttpRequest', UploadRequest))
afterEach(() => vi.unstubAllGlobals())

it('reports request bytes and preserves API headers and receipt', async () => {
  const progress = vi.fn()
  const body = new FormData()
  body.set('audio', new Blob(['audio']))
  const result = uploadFetch(
    '/api/upload',
    {
      method: 'POST',
      body,
      credentials: 'include',
      headers: { Authorization: 'Bearer test', 'X-CSRFToken': 'csrf' },
    },
    progress
  )
  const request = UploadRequest.last
  expect(request.withCredentials).toBe(true)
  expect(request.setRequestHeader).toHaveBeenCalledWith(
    'authorization',
    'Bearer test'
  )
  expect(request.setRequestHeader).not.toHaveBeenCalledWith(
    'content-type',
    expect.anything()
  )
  expect(request.send).toHaveBeenCalledWith(body)
  request.upload.onprogress!({ lengthComputable: true, loaded: 12, total: 24 })
  expect(progress).toHaveBeenCalledWith(12, 24)
  request.onload()
  expect(await (await result).json()).toEqual({ record_id: 'record' })
})

it('stops an in-flight storage request without attaching app credentials', async () => {
  const controller = new AbortController()
  const result = uploadFetch(
    'https://storage.example/object',
    {
      method: 'PUT',
      body: new Blob(['audio']),
      signal: controller.signal,
      headers: { 'Content-Type': 'audio/wav', 'x-amz-acl': 'private' },
    },
    vi.fn()
  )
  expect(UploadRequest.last.withCredentials).toBe(false)
  expect(UploadRequest.last.setRequestHeader).toHaveBeenCalledWith(
    'x-amz-acl',
    'private'
  )
  controller.abort()
  await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  expect(UploadRequest.last.abort).toHaveBeenCalledOnce()
})

it('never starts an already stopped request and removes its abort listener on success', async () => {
  const controller = new AbortController()
  const request = uploadFetch(
    '/api/upload',
    { signal: controller.signal },
    vi.fn()
  )
  UploadRequest.last.onload()
  await request
  controller.abort()
  expect(UploadRequest.last.abort).not.toHaveBeenCalled()
  await expect(
    uploadFetch('/api/upload', { signal: controller.signal }, vi.fn())
  ).rejects.toMatchObject({ name: 'AbortError' })
})
