import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { css } from '@/styled-system/css'
import { useUser } from '@/features/auth'

import { fetchImToken } from '../api/fetchImToken'
import { ChatPane } from './ChatPane'
import { ConnectionStatusBar } from '../components/ConnectionStatusBar'
import { ConversationList } from '../components/ConversationList'
import { useConversations } from '../hooks/useConversations'
import { useImConnection } from '../hooks/useImConnection'

/**
 * `/im` route — split view: conversation list (left) + chat pane (right).
 *
 * Behaviour:
 *   - Not logged in: render an inline prompt (auth guard at the router layer would
 *     also redirect to Keycloak; this branch handles the brief in-between).
 *   - Logged in: mount the SDK Client (singleton), render status + list + (optionally) chat.
 *   - Selecting a conversation lazily loads its history via React Query.
 */
export const ImRoute = () => {
  const { t } = useTranslation('im')
  const { user, isLoggedIn } = useUser()

  if (!isLoggedIn || !user) {
    return (
      <div className={css({ padding: '2rem', color: 'greyscale.700' })}>
        {t('auth.required')}
      </div>
    )
  }

  return <ImAuthenticated />
}

const ImAuthenticated = () => {
  const { t } = useTranslation('im')
  const { client, state } = useImConnection()
  const { data: conversations = [], isLoading: convLoading } = useConversations(client)
  const { data: tokenData } = useQuery({
    queryKey: ['im', 'self-token'],
    queryFn: () => fetchImToken(),
    staleTime: 60_000,
  })
  const [selectedCID, setSelectedCID] = useState<string | null>(null)

  const currentUserUID = tokenData?.uid ?? ''
  const sendDisabled = state !== 'connected'

  return (
    <div
      className={css({
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: '600px',
      })}
    >
      <ConnectionStatusBar state={state} />
      <div
        className={css({
          display: 'flex',
          flex: 1,
          overflow: 'hidden',
        })}
      >
        <aside
          className={css({
            width: '280px',
            borderRight: '1px solid token(colors.greyscale.200)',
            overflowY: 'auto',
            backgroundColor: 'greyscale.50',
          })}
        >
          <h2
            className={css({
              paddingX: '1rem',
              paddingY: '0.75rem',
              margin: 0,
              fontSize: '1rem',
              fontWeight: 'bold',
              color: 'greyscale.900',
            })}
          >
            {t('list.title')}
          </h2>
          <ConversationList
            conversations={conversations}
            selectedCID={selectedCID}
            onSelect={setSelectedCID}
            loading={convLoading}
          />
        </aside>
        <main
          className={css({
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          })}
        >
          {selectedCID ? (
            <ChatPane
              client={client}
              cid={selectedCID}
              currentUserUID={currentUserUID}
              sendDisabled={sendDisabled}
            />
          ) : (
            <div
              className={css({
                padding: '2rem',
                color: 'greyscale.500',
                textAlign: 'center',
                marginTop: '2rem',
              })}
            >
              {t('chat.pickPrompt')}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
