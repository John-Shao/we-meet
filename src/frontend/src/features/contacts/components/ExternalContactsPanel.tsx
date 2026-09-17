import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { Button, SearchBox } from '@/primitives'
import { Modal, ModalCloseButton } from '@/components/Modal'
import { StateHint } from '@/components/StateHint'
import { TitleBar } from '@/components/TitleBar'
import { useConfirm } from '@/components/ConfirmProvider'
import { css } from '@/styled-system/css'

import {
  acceptExternalContactRequest,
  declineExternalContactRequest,
  fetchExternalContactRequests,
  fetchExternalContacts,
  removeExternalContact,
  searchExternalAccounts,
  sendExternalContactRequest,
} from '../api/externalContacts'
import type { ExternalContact } from '../api/ApiDirectory'
import { MemberAvatar } from './MemberAvatar'

interface Props {
  onMessage: (contact: ExternalContact) => Promise<void>
}

const displayName = (contact: ExternalContact) =>
  contact.full_name || contact.short_name || contact.id

export const ExternalContactsPanel = ({ onMessage }: Props) => {
  const { t } = useTranslation('contacts')
  const qc = useQueryClient()
  const { confirm, alert } = useConfirm()
  const [adding, setAdding] = useState(false)
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())
  const locks = useRef(new Set<string>())
  const contacts = useQuery({
    queryKey: ['directory', 'external-contacts'],
    queryFn: fetchExternalContacts,
    staleTime: 30_000,
  })
  const requests = useQuery({
    queryKey: ['directory', 'external-contact-requests'],
    queryFn: fetchExternalContactRequests,
    staleTime: 10_000,
  })

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['directory', 'external-contacts'] }),
      qc.invalidateQueries({
        queryKey: ['directory', 'external-contact-requests'],
      }),
    ])
  }
  const run = async (id: string, operation: () => Promise<unknown>) => {
    if (locks.current.has(id)) return
    locks.current.add(id)
    setBusyIds(new Set(locks.current))
    try {
      await operation()
      await refresh()
    } catch (error) {
      void alert({
        message: t('external.error', {
          message: error instanceof Error ? error.message : String(error),
        }),
      })
    } finally {
      locks.current.delete(id)
      setBusyIds(new Set(locks.current))
    }
  }

  const rows = contacts.data ?? []
  const pending = requests.data ?? []
  return (
    <section className={panelCls} data-testid="external-contacts-panel">
      {/* 内容标题栏走共享件(与通讯录成员列表 / 我的群组同一形态):标题 + 备注
          (一句话说明)一行、不换行;添加按钮留在右侧动作位。 */}
      <TitleBar title={t('external.title')} meta={t('external.hint')}>
        <Button
          variant="secondary"
          size="dense"
          onPress={() => setAdding(true)}
          data-testid="external-contact-add"
        >
          {t('external.add')}
        </Button>
      </TitleBar>
      <div className={bodyCls}>
        {requests.isError && (
          <StateHint
            state="error"
            action={
              <Button size="dense" onPress={() => void requests.refetch()}>
                {t('picker.retry')}
              </Button>
            }
          >
            {t('external.requestsLoadError')}
          </StateHint>
        )}
        {requests.isPending && (
          <StateHint state="loading">{t('external.requestsLoading')}</StateHint>
        )}
        {pending.length > 0 && (
          <div className={sectionCls}>
            <h3 className={sectionTitleCls}>{t('external.requests')}</h3>
            {pending.map((contact) => (
              <ContactRow
                key={contact.relationship_id}
                contact={contact}
                busy={busyIds.has(contact.relationship_id!)}
              >
                {contact.direction === 'incoming' ? (
                  <>
                    <Button
                      variant="primary"
                      size="dense"
                      onPress={() =>
                        void run(contact.relationship_id!, () =>
                          acceptExternalContactRequest(contact.relationship_id!)
                        )
                      }
                    >
                      {t('external.accept')}
                    </Button>
                    <Button
                      variant="secondaryText"
                      size="dense"
                      onPress={() =>
                        void run(contact.relationship_id!, () =>
                          declineExternalContactRequest(
                            contact.relationship_id!
                          )
                        )
                      }
                    >
                      {t('external.decline')}
                    </Button>
                  </>
                ) : (
                  <>
                    <span className={statusCls}>{t('external.pending')}</span>
                    <Button
                      variant="secondaryText"
                      size="dense"
                      onPress={() =>
                        void run(contact.relationship_id!, () =>
                          removeExternalContact(contact.relationship_id!)
                        )
                      }
                    >
                      {t('external.cancelRequest')}
                    </Button>
                  </>
                )}
              </ContactRow>
            ))}
          </div>
        )}

        <div className={sectionCls}>
          {contacts.isError && (
            <StateHint
              state="error"
              action={
                <Button size="dense" onPress={() => void contacts.refetch()}>
                  {t('picker.retry')}
                </Button>
              }
            >
              {t('picker.loadError')}
            </StateHint>
          )}
          {contacts.isFetching && rows.length === 0 ? (
            <StateHint state="loading">{t('page.loading')}</StateHint>
          ) : rows.length === 0 && !contacts.isError ? (
            <StateHint>{t('external.empty')}</StateHint>
          ) : (
            rows.map((contact) => (
              <ContactRow
                key={contact.relationship_id}
                contact={contact}
                busy={busyIds.has(contact.relationship_id!)}
              >
                <span className={externalTagCls}>{t('external.tag')}</span>
                <Button
                  variant="secondary"
                  size="dense"
                  loading={busyIds.has(contact.relationship_id!)}
                  onPress={() =>
                    void run(contact.relationship_id!, () => onMessage(contact))
                  }
                >
                  {t('page.message')}
                </Button>
                <Button
                  variant="secondaryText"
                  size="dense"
                  onPress={async () => {
                    const ok = await confirm({
                      message: t('external.removeConfirm', {
                        name: displayName(contact),
                      }),
                      danger: true,
                    })
                    if (ok) {
                      void run(contact.relationship_id!, () =>
                        removeExternalContact(contact.relationship_id!)
                      )
                    }
                  }}
                >
                  {t('external.remove')}
                </Button>
              </ContactRow>
            ))
          )}
        </div>

        {adding && (
          <AddExternalContactDialog
            onClose={() => setAdding(false)}
            onSent={() => {
              setAdding(false)
              void refresh()
            }}
          />
        )}
      </div>
    </section>
  )
}

const ContactRow = ({
  contact,
  children,
  busy = false,
}: {
  contact: ExternalContact
  children: React.ReactNode
  busy?: boolean
}) => (
  <div className={rowCls}>
    <MemberAvatar
      name={displayName(contact)}
      src={contact.avatar_url}
      size="2.5rem"
    />
    <div className={identityCls}>
      <strong>{displayName(contact)}</strong>
      <span>{contact.organization?.name || '—'}</span>
    </div>
    <fieldset
      disabled={busy}
      aria-busy={busy}
      className={actionsCls}
      style={{ border: 0, padding: 0, margin: 0 }}
    >
      {children}
    </fieldset>
  </div>
)

const AddExternalContactDialog = ({
  onClose,
  onSent,
}: {
  onClose: () => void
  onSent: () => void
}) => {
  const { t } = useTranslation('contacts')
  const { alert } = useConfirm()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ExternalContact[]>([])
  const [busy, setBusy] = useState(false)
  const [searched, setSearched] = useState(false)
  const [searchError, setSearchError] = useState(false)
  const [sending, setSending] = useState<string | null>(null)
  const sendingRef = useRef(false)
  const searchVersion = useRef(0)
  const changeQuery = (value: string) => {
    searchVersion.current += 1
    setQuery(value)
    setResults([])
    setSearched(false)
    setSearchError(false)
    setBusy(false)
  }
  const submitContact = async (contact: ExternalContact) => {
    if (sendingRef.current) return
    sendingRef.current = true
    setSending(contact.id)
    try {
      if (contact.direction === 'incoming')
        await acceptExternalContactRequest(contact.relationship_id!)
      else await sendExternalContactRequest(contact.id)
      onSent()
    } catch (error) {
      void alert({
        message: t('external.error', {
          message: error instanceof Error ? error.message : String(error),
        }),
      })
    } finally {
      sendingRef.current = false
      setSending(null)
    }
  }

  const search = async () => {
    if (!query.trim() || sendingRef.current) return
    const version = ++searchVersion.current
    setBusy(true)
    setSearchError(false)
    setSearched(true)
    try {
      const found = await searchExternalAccounts(query)
      if (version === searchVersion.current) setResults(found)
    } catch {
      if (version === searchVersion.current) setSearchError(true)
    } finally {
      if (version === searchVersion.current) setBusy(false)
    }
  }

  return (
    <Modal
      onClose={onClose}
      ariaLabel={t('external.addTitle')}
      initialFocusRef={inputRef}
      maxWidth="600px"
    >
      <div className={dialogHeaderCls}>
        <div>
          <h2 className={dialogTitleCls}>{t('external.addTitle')}</h2>
          <p className={dialogHintCls}>{t('external.addHint')}</p>
        </div>
        <ModalCloseButton onClose={onClose} label={t('starred.cancel')} />
      </div>
      {/* 回车提交走表单的原生隐式提交(而不是给 SearchBox 开一个 onKeyDown 口子):
          搜索框基元只负责长相与清空,「什么时候发请求」是页面的事。表单里那颗提交
          按钮在空词时是 disabled 的,隐式提交因此也发不出去 —— 与原先那句
          `if (!query.trim()) return` 同一档,不多不少。 */}
      <form
        className={searchCls}
        onSubmit={(event) => {
          event.preventDefault()
          void search()
        }}
      >
        <SearchBox
          value={query}
          onChange={changeQuery}
          placeholder={t('external.searchPlaceholder')}
          inputRef={inputRef}
          className={css({ flex: 1, minWidth: 0 })}
        />
        <Button
          type="submit"
          variant="primary"
          size="action"
          isDisabled={!query.trim() || busy || sending !== null}
        >
          {t('external.search')}
        </Button>
      </form>
      <div className={resultsCls}>
        {busy ? (
          <StateHint state="loading">{t('page.loading')}</StateHint>
        ) : searchError ? (
          <StateHint
            state="error"
            action={
              <Button onPress={() => void search()}>{t('picker.retry')}</Button>
            }
          >
            {t('external.searchError')}
          </StateHint>
        ) : results.length === 0 ? (
          <StateHint>
            {t(searched ? 'external.noMatch' : 'external.searchEmpty')}
          </StateHint>
        ) : (
          results.map((contact) => (
            <ContactRow key={contact.id} contact={contact}>
              {contact.status === 'accepted' ? (
                <span className={statusCls}>
                  {t('external.alreadyContact')}
                </span>
              ) : contact.direction === 'incoming' ? (
                <Button
                  variant="primary"
                  size="dense"
                  loading={sending === contact.id}
                  isDisabled={sending !== null}
                  onPress={() => void submitContact(contact)}
                >
                  {t('external.accept')}
                </Button>
              ) : contact.direction === 'outgoing' ? (
                <span className={statusCls}>{t('external.pending')}</span>
              ) : (
                <Button
                  variant="primary"
                  size="dense"
                  loading={sending === contact.id}
                  isDisabled={sending !== null}
                  onPress={() => void submitContact(contact)}
                >
                  {t('external.sendRequest')}
                </Button>
              )}
            </ContactRow>
          ))
        )}
      </div>
    </Modal>
  )
}

/** 面板:标题栏固定在上,正文自己滚(与成员列表 / 我的群组同一结构)。 */
/** 「添加外部联系人」弹窗自己的页头(原先是借用面板那份,面板改走 TitleBar 后独立出来)。 */
const dialogHeaderCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
  padding: '1rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const dialogTitleCls = css({ margin: 0, fontSize: '1rem', fontWeight: 'bold' })
const dialogHintCls = css({
  margin: '0.25rem 0 0',
  color: 'greyscale.500',
  fontSize: '0.8125rem',
})

const panelCls = css({
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
})
const bodyCls = css({ flex: 1, minHeight: 0, overflowY: 'auto' })

const sectionCls = css({ padding: '0.5rem 1rem' })
const sectionTitleCls = css({ fontSize: '0.8125rem', color: 'greyscale.600' })
const rowCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.75rem',
  paddingY: '0.75rem',
  borderBottom: '1px solid token(colors.greyscale.100)',
})
const identityCls = css({
  display: 'flex',
  flex: 1,
  minWidth: 0,
  flexDirection: 'column',
  fontSize: '0.875rem',
  '& span': { color: 'greyscale.500', fontSize: '0.75rem' },
})
const actionsCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
})
const statusCls = css({ color: 'greyscale.500', fontSize: '0.75rem' })
const externalTagCls = css({
  color: 'warning.subtle-text',
  backgroundColor: 'warning.subtle',
  borderRadius: '0.25rem',
  paddingX: '0.375rem',
  fontSize: '0.6875rem',
})
const searchCls = css({ display: 'flex', gap: '0.5rem', padding: '1rem' })
const resultsCls = css({
  minHeight: '260px',
  maxHeight: '52vh',
  overflowY: 'auto',
  paddingX: '1rem',
})
