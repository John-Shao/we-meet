/** An unreadable existing marker is never equivalent to no pending request. */
export function readRecovery<T>(
  key: string,
  decode: () => T | undefined
): { value?: T; blocked: boolean } {
  try {
    const raw = sessionStorage.getItem(key)
    if (raw === null) return { blocked: false }
    if (!raw || raw.length > 16384) return { blocked: true }
    const value = decode()
    return value === undefined ? { blocked: true } : { value, blocked: false }
  } catch {
    return { blocked: true }
  }
}
