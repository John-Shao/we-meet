/** XHR transport for uploads; authentication remains in authenticatedFetch. */
export function uploadFetch(
  url: string,
  options: RequestInit,
  onProgress: (sent: number, total: number) => void
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const signal = options.signal
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      return
    }
    const xhr = new XMLHttpRequest()
    const stop = () => xhr.abort()
    const done = () => signal?.removeEventListener('abort', stop)
    xhr.open(options.method ?? 'POST', url)
    xhr.withCredentials = options.credentials === 'include'
    new Headers(options.headers).forEach((value, name) =>
      xhr.setRequestHeader(name, value)
    )
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total)
    }
    xhr.onload = () => {
      done()
      const headers = new Headers()
      xhr
        .getAllResponseHeaders()
        .trim()
        .split(/[\r\n]+/)
        .forEach((line) => {
          const colon = line.indexOf(':')
          if (colon > 0)
            headers.append(line.slice(0, colon), line.slice(colon + 1).trim())
        })
      resolve(
        new Response(xhr.status === 204 ? null : xhr.responseText, {
          status: xhr.status,
          headers,
        })
      )
    }
    xhr.onerror = xhr.ontimeout = () => {
      done()
      reject(new TypeError('Upload connection failed'))
    }
    xhr.onabort = () => {
      done()
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', stop, { once: true })
    try {
      xhr.send(options.body as XMLHttpRequestBodyInit)
    } catch (error) {
      done()
      reject(error)
    }
  })
}
