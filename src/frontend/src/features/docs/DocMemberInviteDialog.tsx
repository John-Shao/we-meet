import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/Modal'
import { Button } from '@/primitives'
import { Select } from '@/primitives/Select'
import { DirectoryMultiPicker } from '@/features/contacts'
import { css } from '@/styled-system/css'
import { addDocMembers, memberIds, type MemberRole } from './api/docsSharing'

export function DocMemberInviteDialog({
  docId,
  title,
  onClose,
  onChanged,
}: {
  docId: string
  title: string
  onClose: () => void
  onChanged: () => void
}) {
  const { t } = useTranslation('docs')
  const documentTitle = title ? t('sharing.documentTitle', { title }) : ''
  const [selected, setSelected] = useState(new Map<string, string>())
  const [role, setRole] = useState<MemberRole>('reader')
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  const [result, setResult] = useState<{ done: number; failed: number } | null>(
    null
  )
  const roster = useQuery({
    queryKey: ['docs', 'member-ids', docId],
    queryFn: () => memberIds(docId),
  })
  const close = () => {
    if (!running.current) onClose()
  }
  const submit = async () => {
    if (running.current || !selected.size) return
    running.current = true
    setBusy(true)
    const ids = [...selected.keys()]
    const failed: string[] = []
    try {
      for (let i = 0; i < ids.length; i += 100) {
        if (!active.current) return
        const batch = ids.slice(i, i + 100)
        try {
          failed.push(...(await addDocMembers(docId, batch, role)))
        } catch {
          failed.push(...batch)
        }
      }
      if (!active.current) return
      setSelected(new Map([...selected].filter(([id]) => failed.includes(id))))
      setResult({ done: ids.length - failed.length, failed: failed.length })
      if (failed.length < ids.length) {
        onChanged()
        void roster.refetch()
      }
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  return (
    <Modal
      onClose={close}
      ariaLabel={[t('sharing.invite'), documentTitle].filter(Boolean).join(' ')}
      maxWidth="640px"
      maxHeight="80vh"
    >
      <ModalHeader
        title={
          <>
            <span className={css({ flexShrink: 0 })}>
              {t('sharing.invite')}
            </span>
            {documentTitle && (
              <span
                title={title}
                className={css({
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  textStyle: 'bodyMedium',
                  color: 'text.secondary',
                })}
              >
                {documentTitle}
              </span>
            )}
          </>
        }
        titleClassName={css({
          display: 'flex',
          alignItems: 'center',
          gap: 'xs',
        })}
        onClose={close}
        closeLabel={t('sharing.close')}
      />
      {roster.isPending ? (
        <ModalBody>{t('sharing.loading')}</ModalBody>
      ) : roster.isError ? (
        <ModalBody>
          <p role="alert">{t('sharing.loadError')}</p>
          <Button onPress={() => void roster.refetch()}>
            {t('sharing.retry')}
          </Button>
        </ModalBody>
      ) : (
        <DirectoryMultiPicker
          selected={selected}
          excludeIds={new Set(roster.data)}
          onToggle={(id, label) => {
            if (running.current) return
            setSelected((prev) => {
              const next = new Map(prev)
              if (next.has(id)) next.delete(id)
              else next.set(id, label)
              return next
            })
          }}
          labels={{
            searchPlaceholder: t('sharing.searchUsers'),
            selectedTitle: t('sharing.selected', { count: selected.size }),
            loading: t('sharing.loading'),
            empty: t('sharing.empty'),
            loadMore: t('sharing.loadMore'),
          }}
        />
      )}
      <div
        className={css({
          padding: 'lg',
          display: 'flex',
          flexDirection: 'column',
          gap: 'xs',
          textStyle: 'bodyMedium',
          borderTop: '1px solid token(colors.border.default)',
        })}
      >
        <Select
          aria-label={t('sharing.role')}
          label={
            <span
              className={css({ display: 'block', textStyle: 'labelLarge' })}
            >
              {t('sharing.role')}
            </span>
          }
          selectedKey={role}
          isDisabled={busy}
          onSelectionChange={(key) => setRole(key as MemberRole)}
          items={['reader', 'commenter', 'editor'].map((value) => ({
            value,
            label: t(`sharing.${value}`),
          }))}
        />
        <p
          className={css({
            textStyle: 'bodySmall',
            color: 'text.secondary',
          })}
        >
          {t('sharing.inviteHelp')}
        </p>
        {result && (
          <p role="status">
            {result.failed
              ? t('sharing.inviteResult', result)
              : t('sharing.inviteSuccess', { count: result.done })}
          </p>
        )}
      </div>
      <ModalFooter>
        <Button
          variant="secondary"
          size="action"
          onPress={close}
          isDisabled={busy}
        >
          {t('sharing.cancel')}
        </Button>
        <Button
          variant="primary"
          size="action"
          onPress={() => void submit()}
          loading={busy}
          isDisabled={busy || !selected.size || !roster.data || roster.isError}
        >
          {t('sharing.confirm')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
