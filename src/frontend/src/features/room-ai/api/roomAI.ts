import { useMutation, UseMutationOptions } from '@tanstack/react-query'

import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'

import { AskRoomAIParams, AskRoomAIResponse } from './ApiRoomAI'

const askRoomAI = ({
  roomId,
  token,
  question,
}: AskRoomAIParams): Promise<AskRoomAIResponse> =>
  fetchApi(`rooms/${roomId}/ask-ai/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ question }),
  })

export const useAskRoomAI = (
  options?: UseMutationOptions<AskRoomAIResponse, ApiError, AskRoomAIParams>
) =>
  useMutation<AskRoomAIResponse, ApiError, AskRoomAIParams>({
    mutationFn: askRoomAI,
    ...options,
  })
