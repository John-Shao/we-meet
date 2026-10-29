import { useCallback, useState } from 'react'

const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `work-${Date.now()}-${Math.random().toString(36).slice(2)}`

export const useIdempotencyKey = () => {
  const [key, setKey] = useState(newKey)
  const rotate = useCallback(() => setKey(newKey()), [])
  return { key, rotate }
}
