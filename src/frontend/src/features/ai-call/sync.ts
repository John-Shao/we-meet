import { fetchApi } from '@/api/fetchApi'

const DEVICE_KEY = 'we-meet:ai-call-device'
const API = 'ai-call/conversations/'

export type SyncRow = {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
}
export type SyncTodo = { text: string; done?: boolean }
export type SyncRecord = {
  id: string
  startedAt: number
  seconds: number
  rows: SyncRow[]
  remoteId?: string
  title?: string
  summary?: string
  todos?: SyncTodo[]
}

type ServerMessage = {
  id: string
  client_id: string
  position: number
  role: SyncRow['role']
  text: string
}
type ServerConversation = {
  id: string
  client_id: string
  started_at: string
  ended_at?: string | null
  title?: string
  summary?: string
  todos?: SyncTodo[]
  messages?: ServerMessage[]
  message_count?: number
}

const deviceId = () => {
  let value = localStorage.getItem(DEVICE_KEY)
  if (!value) {
    value = crypto.randomUUID()
    localStorage.setItem(DEVICE_KEY, value)
  }
  return value
}

const toSyncRecord = (server: ServerConversation): SyncRecord | null => {
  const started = Date.parse(server.started_at)
  if (!Number.isFinite(started) || !server.client_id) return null
  const ended = server.ended_at ? Date.parse(server.ended_at) : started
  return {
    id: server.client_id,
    startedAt: started,
    seconds: Number.isFinite(ended)
      ? Math.max(0, Math.round((ended - started) / 1000))
      : 0,
    remoteId: server.id,
    ...(server.title ? { title: server.title } : {}),
    ...(server.summary ? { summary: server.summary } : {}),
    ...(server.todos?.length ? { todos: server.todos } : {}),
    rows: (server.messages ?? []).map((message) => ({
      id: message.client_id,
      role: message.role,
      text: message.text,
    })),
  }
}

export async function pullAiCallHistory(): Promise<SyncRecord[]> {
  const response = await fetchApi<{ conversations: ServerConversation[] }>(
    `${API}?include_messages=1`
  )
  return response.conversations
    .map(toSyncRecord)
    .filter((record): record is SyncRecord => record !== null)
}

export async function pushAiCallHistory(
  record: SyncRecord
): Promise<string | undefined> {
  const endedAt = new Date(
    record.startedAt + record.seconds * 1000
  ).toISOString()
  const result = await fetchApi<ServerConversation>(API, {
    method: 'POST',
    body: JSON.stringify({
      client_id: record.id,
      device_id: deviceId(),
      kind: 'call',
      title: record.title ?? '',
      started_at: new Date(record.startedAt).toISOString(),
      ended_at: endedAt,
      status: 'completed',
      summary: record.summary ?? '',
      todos: record.todos ?? [],
      messages: record.rows.map((row, position) => ({
        client_id: row.id,
        position,
        role: row.role,
        text: row.text,
        source: '',
      })),
    }),
  })
  return result.id
}

export async function deleteRemoteCallHistory(remoteId: string): Promise<void> {
  await fetchApi(`${API}${encodeURIComponent(remoteId)}/`, { method: 'DELETE' })
}
