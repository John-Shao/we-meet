import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { keys } from '@/api/queryKeys'
import { ApiError } from '@/api/ApiError'
import {
  requestEntry,
  ApiLobbyStatus,
  ApiRequestEntry,
} from '../api/requestEntry'

export const WAIT_TIMEOUT_MS = 600000 // 10 minutes
export const POLL_INTERVAL_MS = 1000

export const useLobby = ({
  roomId,
  username,
  onAccepted,
}: {
  roomId: string
  username: string
  onAccepted: (e: ApiRequestEntry) => void
}) => {
  const [status, setStatus] = useState(ApiLobbyStatus.IDLE)
  const waitingTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const clearWaitingTimeout = useCallback(() => {
    if (waitingTimeoutRef.current) {
      clearTimeout(waitingTimeoutRef.current)
      waitingTimeoutRef.current = null
    }
  }, [])

  const startWaitingTimeout = useCallback(() => {
    clearWaitingTimeout()
    waitingTimeoutRef.current = setTimeout(() => {
      setStatus(ApiLobbyStatus.TIMEOUT)
    }, WAIT_TIMEOUT_MS)
  }, [clearWaitingTimeout])

  const { data: waitingData } = useQuery({
    queryKey: [keys.requestEntry, roomId],
    queryFn: async () => {
      let response: ApiRequestEntry
      try {
        response = await requestEntry({
          roomId,
          username,
        })
      } catch (e) {
        // The owner ended the room while we were polling — backend now
        // returns 404 from request-entry. Treat as a terminal ENDED state
        // so the UI can surface a "meeting ended" message instead of
        // spinning on "waiting for host" forever.
        if (e instanceof ApiError && e.statusCode === 404) {
          clearWaitingTimeout()
          setStatus(ApiLobbyStatus.ENDED)
        }
        throw e
      }
      if (response.status === ApiLobbyStatus.ACCEPTED) {
        clearWaitingTimeout()
        setStatus(ApiLobbyStatus.ACCEPTED)
        onAccepted(response)
      } else if (response.status === ApiLobbyStatus.DENIED) {
        clearWaitingTimeout()
        setStatus(ApiLobbyStatus.DENIED)
      }
      return response
    },
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: false,
    refetchIntervalInBackground: true,
    enabled: status === ApiLobbyStatus.WAITING,
  })

  const startWaiting = useCallback(() => {
    setStatus(ApiLobbyStatus.WAITING)
    startWaitingTimeout()
  }, [startWaitingTimeout])

  const markEnded = useCallback(() => {
    clearWaitingTimeout()
    setStatus(ApiLobbyStatus.ENDED)
  }, [clearWaitingTimeout])

  useEffect(() => {
    return () => clearWaitingTimeout()
  }, [clearWaitingTimeout])

  return {
    status,
    startWaiting,
    markEnded,
    waitingData,
  }
}
