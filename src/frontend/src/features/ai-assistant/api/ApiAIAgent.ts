/**
 * Wire types for the AI assistant catalog API.
 *
 * The catalog is fully DB-driven on the backend; profile_code is the only
 * string identifier shared with the agent worker. Voices and prompts are
 * UUIDs that resolve server-side against the user's preference / profile
 * defaults.
 */

export type AIArchitecture = 'omni' | 'pipeline'

export interface AIVoiceOption {
  id: string
  value: string
  label: string
}

export interface AIPromptOption {
  id: string
  label: string
  content: string
  category_code: string
  category_label: string
}

export interface AIPromptCategoryOption {
  code: string
  label: string
}

export interface AIAgentProfile {
  code: string
  display_name: string
  architecture: AIArchitecture
  voices: AIVoiceOption[]
  default_voice_id: string | null
  default_prompt_id: string | null
}

export interface AIUserPreference {
  profile_code: string | null
  voice_id: string | null
  prompt_id: string | null
}

export interface AIAgentConfigResponse {
  profiles: AIAgentProfile[]
  prompts: AIPromptOption[]
  categories: AIPromptCategoryOption[]
  user_preference: AIUserPreference | null
}

export interface StartAIAgentParams {
  roomId: string
  token: string
  profileCode: string
  voiceId?: string | null
  promptId?: string | null
}

export interface StopAIAgentParams {
  roomId: string
  token: string
}

export interface AIAgentStartResponse {
  status: string
  profile_code: string
  voice_id: string | null
  prompt_id: string | null
}
