import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/Modal'
import { Button } from '@/primitives'
import { Select } from '@/primitives/Select'
import { css } from '@/styled-system/css'
import { ForwardDialog } from '@/features/im/components/ForwardDialog'
import { GroupPicker } from '@/features/im/components/GroupPicker'
import { buildDocCardBody } from '@/features/im/components/docCard'
import { useForwardConversations } from '@/features/im/hooks/useForwardConversations'
import { createGroupConversation } from '@/features/im/api/createGroupConversation'
import { grantChatAccess, type ShareRole } from './api/docsSharing'
import { deliverDocument, type Delivery } from './shareDelivery'

export function DocShareToChatDialog({
  doc,
  onClose,
  onChanged,
}: {
  doc: {
    docId: string
    title: string
    url: string
    role?: ShareRole
    canManage?: boolean
  }
  onClose: () => void
  onChanged: () => void
}) {
  const { t } = useTranslation('docs')
  const { client, conversations, isLoading } = useForwardConversations()
  const [role, setRole] = useState<ShareRole>(doc.role || 'reader')
  const [targets, setTargets] = useState<Delivery[] | null>(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const [group, setGroup] = useState(false)
  const [groupError, setGroupError] = useState(false)
  const body = buildDocCardBody({
    id: doc.docId,
    title: doc.title,
    url: doc.url,
  })
  const run = async (items: Delivery[]) => {
    if (running.current || !active.current) return
    running.current = true
    setBusy(true)
    setTargets((prev) => prev || items)
    try {
      await deliverDocument(
        items,
        (cid) => client.sendText(cid, body, { contentType: 'doc-card' }),
        doc.canManage ? (cid) => grantChatAccess(doc.docId, cid, role) : null,
        (item) => {
          if (active.current)
            setTargets((prev) =>
              prev!.map((row) => (row.cid === item.cid ? item : row))
            )
        },
        () => active.current
      )
      if (active.current) onChanged()
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  const close = () => {
    if (!running.current) onClose()
  }
  const controls = (
    <div
      className={css({
        flexShrink: 0,
        padding: '0.75rem 1rem',
        textStyle: 'bodyMedium',
      })}
    >
      {doc.canManage ? (
        <Select
          aria-label={t('sharing.role')}
          label={
            <span className={css({ display: 'block', marginBottom: 'xs' })}>
              {t('sharing.chatRole')}
            </span>
          }
          selectedKey={role}
          onSelectionChange={(key) => setRole(key as ShareRole)}
          items={['reader', 'editor'].map((value) => ({
            value,
            label: t(`sharing.${value}`),
          }))}
        />
      ) : (
        <p>{t('sharing.sendOnlyHelp')}</p>
      )}
      {groupError && <p role="alert">{t('sharing.groupError')}</p>}
    </div>
  )
  if (targets)
    return (
      <Modal onClose={close} ariaLabel={t('sharing.result')} maxWidth="540px">
        <ModalHeader
          title={t('sharing.result')}
          onClose={close}
          closeLabel={t('sharing.close')}
        />
        <ModalBody>
          <p>{doc.title}</p>
          <ul className={css({ listStyle: 'none', padding: 0 })}>
            {targets.map((item) => (
              <li key={item.cid} className={css({ paddingY: '0.75rem' })}>
                <strong>
                  {conversations.find((c) => c.cid === item.cid)?.name ||
                    t('sharing.newConversation')}
                </strong>
                <p role="status">
                  {t(
                    item.error === 'send'
                      ? 'sharing.sendUnconfirmed'
                      : item.error === 'access'
                        ? 'sharing.accessFailed'
                        : item.sent && (!doc.canManage || item.authorized)
                          ? item.authorized
                            ? 'sharing.authorized'
                            : 'sharing.sent'
                          : 'sharing.sending'
                  )}
                </p>
              </li>
            ))}
          </ul>
          {targets.some((item) => item.error === 'send') && (
            <p>{t('sharing.checkBeforeRetry')}</p>
          )}
        </ModalBody>
        <ModalFooter>
          {targets.some((item) => item.error === 'access') && (
            <Button
              variant="primary"
              isDisabled={busy}
              loading={busy}
              onPress={() =>
                void run(targets.filter((item) => item.error === 'access'))
              }
            >
              {t('sharing.retryAccess')}
            </Button>
          )}
          {targets.some((item) => item.error === 'send') && (
            <Button
              variant="secondary"
              isDisabled={busy}
              onPress={() =>
                void run(targets.filter((item) => item.error === 'send'))
              }
            >
              {t('sharing.retrySend')}
            </Button>
          )}
          <Button onPress={close} isDisabled={busy}>
            {t('sharing.done')}
          </Button>
        </ModalFooter>
      </Modal>
    )
  if (group)
    return (
      <GroupPicker
        onClose={() => {
          if (!running.current) setGroup(false)
        }}
        onCreate={(ids, name) => {
          if (running.current || !active.current) return
          running.current = true
          void createGroupConversation(ids, name)
            .then((created) => {
              running.current = false
              if (!active.current) return
              setGroup(false)
              void run([{ cid: created.cid, sent: false, authorized: false }])
            })
            .catch(() => {
              running.current = false
              setGroup(false)
              setGroupError(true)
            })
        }}
      />
    )
  return (
    <ForwardDialog
      conversations={conversations}
      isLoading={isLoading}
      previewText={doc.title}
      title={t('sharing.chat')}
      footerContent={controls}
      maxWidth="560px"
      onCreateGroupForward={() => setGroup(true)}
      onClose={close}
      onConfirm={(cids) =>
        void run(
          [...new Set(cids)].map((cid) => ({
            cid,
            sent: false,
            authorized: false,
          }))
        )
      }
    />
  )
}
