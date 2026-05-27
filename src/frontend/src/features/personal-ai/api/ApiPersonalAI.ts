/**
 * Cross-meeting AI — single-turn RAG over the user's accessible meetings.
 * Sprint 2.4. Wire types for POST /users/me/ai/ask/.
 */

export interface AskPersonalAIParams {
  question: string
}

export interface PersonalAIRoomRef {
  id: string
  name: string
  slug: string
}

export interface AskPersonalAIResponse {
  answer: string
  chunks_used: number
  rooms_referenced: PersonalAIRoomRef[]
  model_used: string
}
