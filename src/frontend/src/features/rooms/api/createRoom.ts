import { useMutation, UseMutationOptions } from '@tanstack/react-query'
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
  return useMutation<ApiRoom, ApiError, CreateRoomParams>({
    mutationFn: createRoom,
    onSuccess: options?.onSuccess,
  })
}
