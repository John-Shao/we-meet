import { useMutation, useQuery, UseMutationOptions } from '@tanstack/react-query'

import { ApiError } from '@/api/ApiError'
import { fetchApi } from '@/api/fetchApi'

import {
  AIAgentConfigResponse,
  AIAgentStartResponse,
  StartAIAgentParams,
  StopAIAgentParams,
} from './ApiAIAgent'

const getAIAgentConfig = (): Promise<AIAgentConfigResponse> =>
  fetchApi(`rooms/ai-agent-config/`)

export const useAIAgentConfig = () =>
  useQuery<AIAgentConfigResponse, ApiError>({
    queryKey: ['ai-agent-config'],
    queryFn: getAIAgentConfig,
    staleTime: 60_000,
  })

const startAIAgent = ({
  roomId,
  token,
  profileCode,
  voiceId,
  promptId,
}: StartAIAgentParams): Promise<AIAgentStartResponse> =>
  fetchApi(`rooms/${roomId}/start-ai-agent/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      profile_code: profileCode,
      voice_id: voiceId ?? null,
      prompt_id: promptId ?? null,
    }),
  })

export const useStartAIAgent = (
  options?: UseMutationOptions<
    AIAgentStartResponse,
    ApiError,
    StartAIAgentParams
  >
) =>
  useMutation<AIAgentStartResponse, ApiError, StartAIAgentParams>({
    mutationFn: startAIAgent,
    ...options,
  })

const stopAIAgent = ({
  roomId,
  token,
}: StopAIAgentParams): Promise<void> =>
  fetchApi(`rooms/${roomId}/stop-ai-agent/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })

export const useStopAIAgent = (
  options?: UseMutationOptions<void, ApiError, StopAIAgentParams>
) =>
  useMutation<void, ApiError, StopAIAgentParams>({
    mutationFn: stopAIAgent,
    ...options,
  })
