import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { css } from '@/styled-system/css'
import { useUser } from '@/features/auth'

import { createDirectConversation } from '../api/createDirectConversation'
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
  const qc = useQueryClient()

  const currentUserUID = tokenData?.uid ?? ''
  const sendDisabled = state !== 'connected'

  // MVP 联调入口: prompt 输对方 IM uid -> backend 走 jusi admin create-or-get direct.
  // 升级方向: 替换成内嵌的 user picker (按 phone / name 反查 uid), 见 todo (S4+).
  const handleNewDirect = async () => {
    if (!currentUserUID) {
      window.alert(t('list.newDirect.notReady'))
      return
    }
    const peerUid = window.prompt(
      t('list.newDirect.prompt', { selfUid: currentUserUID }),
    )
    if (peerUid === null) return
    const trimmed = peerUid.trim()
    if (!trimmed) return
    try {
      const result = await createDirectConversation(trimmed)
      await qc.invalidateQueries({ queryKey: ['im', 'conversations'] })
      setSelectedCID(result.cid)
    } catch (e) {
      window.alert(
        t('list.newDirect.error', {
          message: e instanceof Error ? e.message : String(e),
        }),
      )
    }
  }

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
          <div
            className={css({
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingX: '1rem',
              paddingY: '0.75rem',
            })}
          >
            <h2
              className={css({
                margin: 0,
                fontSize: '1rem',
                fontWeight: 'bold',
                color: 'greyscale.900',
              })}
            >
              {t('list.title')}
            </h2>
            <button
              type="button"
              onClick={handleNewDirect}
              title={t('list.newDirect.button')}
              aria-label={t('list.newDirect.button')}
              data-testid="im-new-direct"
              className={css({
                border: '1px solid token(colors.greyscale.300)',
                borderRadius: '999px',
                backgroundColor: 'white',
                width: '1.75rem',
                height: '1.75rem',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '1.125rem',
                lineHeight: 1,
                cursor: 'pointer',
                color: 'greyscale.700',
                _hover: { backgroundColor: 'greyscale.100' },
              })}
            >
              +
            </button>
          </div>
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
