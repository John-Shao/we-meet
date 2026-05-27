import { useMutation, UseMutationOptions } from '@tanstack/react-query'

import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'

import { AskPersonalAIParams, AskPersonalAIResponse } from './ApiPersonalAI'

const askPersonalAI = ({
  question,
}: AskPersonalAIParams): Promise<AskPersonalAIResponse> =>
  fetchApi(`users/me/ai/ask/`, {
    method: 'POST',
    body: JSON.stringify({ question }),
  })

export const useAskPersonalAI = (
  options?: UseMutationOptions<
    AskPersonalAIResponse,
    ApiError,
    AskPersonalAIParams
  >
) =>
  useMutation<AskPersonalAIResponse, ApiError, AskPersonalAIParams>({
    mutationFn: askPersonalAI,
    ...options,
  })
