import {
  useMutation,
  useQueryClient,
  UseMutationOptions,
} from '@tanstack/react-query'
import { fetchApi } from '@/api/fetchApi'
import { ApiError } from '@/api/ApiError'
import { ApiRoom } from './ApiRoom'

export interface CreateRoomParams {
  /** Human-readable room name. Backend generates the joinable slug on save. */
  name: string
  callbackId?: string
  username?: string
  /**
   * Optional ISO 8601 timestamp for a scheduled meeting (Home → 预约会议).
   * Persisted on Room.scheduled_at; surfaces in the invite dialog so the
   * host shares "scheduled for X" alongside the link. Omit for instant
   * or unscheduled "persistent" rooms.
   */
  scheduledAt?: string
}

const createRoom = ({
  name,
  callbackId,
  username = '',
  scheduledAt,
}: CreateRoomParams): Promise<ApiRoom> => {
  return fetchApi(`rooms/?username=${encodeURIComponent(username)}`, {
    method: 'POST',
    body: JSON.stringify({
      name,
      callback_id: callbackId,
      ...(scheduledAt && { scheduled_at: scheduledAt }),
    }),
  })
}

export function useCreateRoom(
  options?: UseMutationOptions<ApiRoom, ApiError, CreateRoomParams>
) {
  const qc = useQueryClient()
  const callerOnSuccess = options?.onSuccess
  return useMutation<ApiRoom, ApiError, CreateRoomParams>({
    ...options,
    mutationFn: createRoom,
    onSuccess: (...args) => {
      // Refresh Home's room lists whenever a room is created — both the
      // "scheduled meetings" overview and the recent-meetings feed pick
      // it up without the user having to reload.
      qc.invalidateQueries({ queryKey: ['scheduled-meetings'] })
      qc.invalidateQueries({ queryKey: ['recent-meetings'] })
      // Forward the full arg tuple (react-query v5 added a 4th param so
      // a fixed-arity wrapper would break callers that rely on it).
      return callerOnSuccess?.(...args)
    },
  })
}
