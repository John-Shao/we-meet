import {
  createContext,
  useCallback,
  useContext,
  useState,
  type SetStateAction,
} from 'react'
export const ViewState = createContext<Map<string, unknown> | null>(null)

export function useRecordViewState<T>(key: string, initial: T | (() => T)) {
  const values = useContext(ViewState)
  const [value, setValue] = useState<T>(() =>
    values?.has(key)
      ? (values.get(key) as T)
      : typeof initial === 'function'
        ? (initial as () => T)()
        : initial
  )
  const update = useCallback(
    (next: SetStateAction<T>) =>
      setValue((previous) => {
        const resolved =
          typeof next === 'function'
            ? (next as (value: T) => T)(previous)
            : next
        values?.set(key, resolved)
        return resolved
      }),
    [key, values]
  )
  return [value, update] as const
}
