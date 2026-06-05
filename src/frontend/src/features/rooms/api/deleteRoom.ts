import {
  useMutation,
  useQueryClient,
  UseMutationOptions,
} from '@tanstack/react-query'
import { fetchApi } from '@/api/fetchApi'
import { ApiError } from '@/api/ApiError'

/**
 * Hard-delete a room on the backend. The DRF `RoomPermissions` class
 * requires `is_owner(user)` for DELETE, so non-owner callers get HTTP
 * 403 — callers should treat the 403 as "I'm not the owner" and fall
 * back to a local-only hide (Home re-renders without the row after
 * the invalidate below).
 *
 * Path slot accepts either the UUID id or the slug (Home rows have
 * the slug handy; meeting-detail has the id). Both work.
 */
const deleteRoom = (idOrSlug: string): Promise<void> =>
  fetchApi(`rooms/${idOrSlug}/`, { method: 'DELETE' })

export function useDeleteRoom(
  options?: UseMutationOptions<void, ApiError, string>
) {
  const qc = useQueryClient()
  const callerOnSuccess = options?.onSuccess
  return useMutation<void, ApiError, string>({
    ...options,
    mutationFn: deleteRoom,
    onSuccess: (...args) => {
      // Refresh Home's two lists so the deleted row disappears.
      qc.invalidateQueries({ queryKey: ['scheduled-meetings'] })
      qc.invalidateQueries({ queryKey: ['recent-meetings'] })
      return callerOnSuccess?.(...args)
    },
  })
}
