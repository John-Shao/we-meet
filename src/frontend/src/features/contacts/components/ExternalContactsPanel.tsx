import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { Button } from '@/primitives'
import { Modal, ModalCloseButton } from '@/components/Modal'
import { StateHint } from '@/components/StateHint'
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
  const run = async (operation: () => Promise<unknown>) => {
    try {
      await operation()
      await refresh()
    } catch (error) {
      void alert({
        message: t('external.error', {
          message: error instanceof Error ? error.message : String(error),
        }),
      })
    }
  }

  const rows = contacts.data ?? []
  const pending = requests.data ?? []
  return (
    <section className={panelCls} data-testid="external-contacts-panel">
      <header className={headerCls}>
        <div>
          <h2 className={titleCls}>{t('external.title')}</h2>
          <p className={hintCls}>{t('external.hint')}</p>
        </div>
        <Button
          variant="secondary"
          size="dense"
          onPress={() => setAdding(true)}
          data-testid="external-contact-add"
        >
          {t('external.add')}
        </Button>
      </header>

      {pending.length > 0 && (
        <div className={sectionCls}>
          <h3 className={sectionTitleCls}>{t('external.requests')}</h3>
          {pending.map((contact) => (
            <ContactRow key={contact.relationship_id} contact={contact}>
              {contact.direction === 'incoming' ? (
                <>
                  <Button
                    variant="primary"
                    size="dense"
                    onPress={() =>
                      void run(() =>
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
                      void run(() =>
                        declineExternalContactRequest(contact.relationship_id!)
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
                      void run(() =>
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
        {contacts.isFetching && rows.length === 0 ? (
          <StateHint loading>{t('page.loading')}</StateHint>
        ) : rows.length === 0 ? (
          <StateHint>{t('external.empty')}</StateHint>
        ) : (
          rows.map((contact) => (
            <ContactRow key={contact.relationship_id} contact={contact}>
              <span className={externalTagCls}>{t('external.tag')}</span>
              <Button
                variant="secondary"
                size="dense"
                onPress={() => void onMessage(contact)}
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
                    void run(() => removeExternalContact(contact.relationship_id!))
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
    </section>
  )
}

const ContactRow = ({
  contact,
  children,
}: {
  contact: ExternalContact
  children: React.ReactNode
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
    <div className={actionsCls}>{children}</div>
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

  const search = async () => {
    if (!query.trim()) return
    setBusy(true)
    try {
      setResults(await searchExternalAccounts(query))
    } catch (error) {
      void alert({
        message: t('external.error', {
          message: error instanceof Error ? error.message : String(error),
        }),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      onClose={onClose}
      ariaLabel={t('external.addTitle')}
      initialFocusRef={inputRef}
      maxWidth="600px"
    >
      <div className={headerCls}>
        <div>
          <h2 className={titleCls}>{t('external.addTitle')}</h2>
          <p className={hintCls}>{t('external.addHint')}</p>
        </div>
        <ModalCloseButton onClose={onClose} label={t('starred.cancel')} />
      </div>
      <div className={searchCls}>
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void search()
            }
          }}
          placeholder={t('external.searchPlaceholder')}
          className={inputCls}
        />
        <Button
          variant="primary"
          size="action"
          onPress={() => void search()}
          isDisabled={!query.trim() || busy}
        >
          {t('external.search')}
        </Button>
      </div>
      <div className={resultsCls}>
        {busy ? (
          <StateHint loading>{t('page.loading')}</StateHint>
        ) : results.length === 0 ? (
          <StateHint>{t('external.searchEmpty')}</StateHint>
        ) : (
          results.map((contact) => (
            <ContactRow key={contact.id} contact={contact}>
              {contact.status === 'accepted' ? (
                <span className={statusCls}>{t('external.alreadyContact')}</span>
              ) : contact.direction === 'incoming' ? (
                <Button
                  variant="primary"
                  size="dense"
                  onPress={async () => {
                    await acceptExternalContactRequest(contact.relationship_id!)
                    onSent()
                  }}
                >
                  {t('external.accept')}
                </Button>
              ) : contact.direction === 'outgoing' ? (
                <span className={statusCls}>{t('external.pending')}</span>
              ) : (
                <Button
                  variant="primary"
                  size="dense"
                  onPress={async () => {
                    await sendExternalContactRequest(contact.id)
                    onSent()
                  }}
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

const panelCls = css({ height: '100%', overflowY: 'auto' })
const headerCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
  padding: '1rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const titleCls = css({ margin: 0, fontSize: '1rem', fontWeight: 'bold' })
const hintCls = css({ margin: '0.25rem 0 0', color: 'greyscale.500', fontSize: '0.8125rem' })
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
const actionsCls = css({ display: 'flex', alignItems: 'center', gap: '0.375rem' })
const statusCls = css({ color: 'greyscale.500', fontSize: '0.75rem' })
const externalTagCls = css({
  color: 'warning.700',
  backgroundColor: 'warning.100',
  borderRadius: '0.25rem',
  paddingX: '0.375rem',
  fontSize: '0.6875rem',
})
const searchCls = css({ display: 'flex', gap: '0.5rem', padding: '1rem' })
const inputCls = css({
  flex: 1,
  minWidth: 0,
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.5rem',
  paddingX: '0.75rem',
})
const resultsCls = css({ minHeight: '260px', maxHeight: '52vh', overflowY: 'auto', paddingX: '1rem' })
