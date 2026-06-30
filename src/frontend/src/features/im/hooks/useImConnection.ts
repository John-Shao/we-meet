import { useEffect, useState } from 'react'
import type { Client, ConnectionState } from '@jusi/light-im-sdk'

import { getImClient } from '../sdk/singleton'

export interface ImConnectionHandle {
  client: Client
  state: ConnectionState
}

/**
 * Mounts the IM SDK Client and exposes its connection state.
 *
 * Lifecycle:
 *   - first hook usage triggers Client.connect()
 *   - state changes propagate via React render
 *   - disconnect happens only on full logout (resetImClient), not on unmount,
 *     because the Client is a singleton shared by every /im-related component
 */
export const useImConnection = (): ImConnectionHandle => {
  const client = getImClient()
  const [state, setState] = useState<ConnectionState>(client.state)

  useEffect(() => {
    const off = client.onStateChange((s) => setState(s))
    if (client.state === 'disconnected') {
      // fire-and-forget; errors propagate via state ('auth_failed')
      void client.connect().catch(() => {
        // state machine already transitioned; nothing else to do here
      })
    }
    return off
  }, [client])

  return { client, state }
}
