import { useRoomData } from '../livekit/hooks/useRoomData'
import { fetchApi } from '@/api/fetchApi'

export const useEndRoom = () => {
  const data = useRoomData()

  const endRoom = async () => {
    if (!data?.id) {
      throw new Error('Room id is not available')
    }

    return fetchApi(`rooms/${data.id}/end/`, {
      method: 'POST',
    })
  }
  return { endRoom }
}
