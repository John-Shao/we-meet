/**
 * Room sidebar AI — single-turn QA over the current meeting's transcripts.
 * Sprint 2.3. Wire types for POST /rooms/{id}/ask-ai/.
 */

export interface AskRoomAIParams {
  /** Room UUID. Pulled from useRoomData(). */
  roomId: string
  /** LiveKit JWT proving the caller is in this very room. */
  token: string
  /** Free-text question, ≤500 chars. */
  question: string
}

export interface AskRoomAIResponse {
  answer: string
  transcripts_used: number
  model_used: string
}
