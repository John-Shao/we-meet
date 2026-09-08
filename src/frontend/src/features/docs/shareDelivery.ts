/** Confirmed deliveries are never repeated when retrying permissions or other targets. */
export interface Delivery {
  cid: string
  sent: boolean
  authorized: boolean
  error?: 'send' | 'access'
}
export async function deliverDocument(
  targets: Delivery[],
  send: (cid: string) => Promise<unknown>,
  grant: ((cid: string) => Promise<unknown>) | null,
  onProgress: (target: Delivery) => void,
  isActive: () => boolean = () => true
): Promise<Delivery[]> {
  const results: Delivery[] = []
  for (const original of targets) {
    if (!isActive()) break
    const target: Delivery = { ...original, error: undefined }
    if (!target.sent) {
      try {
        await send(target.cid)
        target.sent = true
      } catch {
        target.error = 'send'
        onProgress(target)
        results.push(target)
        continue
      }
    }
    if (!isActive()) break
    if (grant && !target.authorized) {
      try {
        await grant(target.cid)
        target.authorized = true
      } catch {
        target.error = 'access'
      }
    }
    onProgress(target)
    results.push(target)
  }
  return results
}
