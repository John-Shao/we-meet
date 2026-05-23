import { useMutation, UseMutationOptions } from '@tanstack/react-query'
import { fetchApi } from '@/api/fetchApi'
import { ApiError } from '@/api/ApiError'
import { ApiRoom } from './ApiRoom'

export interface CreateRoomParams {
  /** Human-readable room name. Backend generates the joinable slug on save. */
  name: string
  callbackId?: string
  username?: string
}

const createRoom = ({
  name,
  callbackId,
  username = '',
}: CreateRoomParams): Promise<ApiRoom> => {
  return fetchApi(`rooms/?username=${encodeURIComponent(username)}`, {
    method: 'POST',
    body: JSON.stringify({
      name,
      callback_id: callbackId,
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
