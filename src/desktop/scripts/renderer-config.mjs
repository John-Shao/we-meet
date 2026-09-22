export function rendererConfig(env = process.env) {
  const serviceOrigin = env.WEMEET_SERVICE_URL || 'https://meet.we-meet.online'
  const imBaseUrl = env.WEMEET_IM_URL ||
    (serviceOrigin === 'https://meet.we-meet.online' ? 'https://im.we-meet.online' : '')
  if (!imBaseUrl) throw new Error('Set WEMEET_IM_URL when building for a custom service')
  for (const raw of [serviceOrigin, imBaseUrl]) {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('Desktop service and IM URLs must be HTTPS origins')
    }
  }
  return { serviceOrigin: new URL(serviceOrigin).origin, imBaseUrl: new URL(imBaseUrl).origin, appTitle: 'We-Meet' }
}
