import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'wouter'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { css } from '@/styled-system/css'
import { useUser } from '@/features/auth'

import { ContactPicker } from '@/features/contacts'
import type { DirectoryMember } from '@/features/contacts'

import { createDirectConversationByUserId } from '../api/createDirectConversation'
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
  // 从通讯录跳来时 URL 带 ?cid=<会话>,直接预选并打开该会话。
  const [searchParams] = useSearchParams()
  const initialCID = searchParams.get('cid')
  const [selectedCID, setSelectedCID] = useState<string | null>(initialCID)
  const [pickerOpen, setPickerOpen] = useState(false)
  const qc = useQueryClient()

  // 带 cid 进来时刷新会话列表,让新建/已存在的会话出现在左栏(ChatPane 本身已按 cid 渲染)。
  useEffect(() => {
    if (initialCID) {
      setSelectedCID(initialCID)
      void qc.invalidateQueries({ queryKey: ['im', 'conversations'] })
    }
  }, [initialCID, qc])

  const currentUserUID = tokenData?.uid ?? ''
  const sendDisabled = state !== 'connected'

  // 通讯录选人 -> backend 用 peer_user_id 服务端解析对方 IM uid -> jusi admin
  // create-or-get direct。客户端不再需要手输/知道原始 IM uid。
  const handleSelectMember = async (member: DirectoryMember) => {
    setPickerOpen(false)
    try {
      const result = await createDirectConversationByUserId(member.id)
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
              onClick={() => setPickerOpen(true)}
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
      {pickerOpen && (
        <ContactPicker
          onSelect={handleSelectMember}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  )
}
