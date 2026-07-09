import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import { Modal } from '@/components/Modal'
import { MemberAvatar } from '@/features/contacts'

import { GroupAvatar, type GroupAvatarMember } from './GroupAvatar'

/** A forward target as seen by the picker — resolved upstream in ImRoute. */
export interface ForwardConv {
  cid: string
  name: string
  /** direct peer avatar (presigned); undefined for groups. */
  avatarUrl?: string
  /** group member tiles for the mosaic avatar; undefined for direct. */
  members?: GroupAvatarMember[]
  isGroup: boolean
}

interface Props {
  conversations: ForwardConv[]
  /** One-line preview of the message being forwarded (shown at the top). */
  previewText: string
  /** Confirm forwarding to one or more target conversations (飞书式多选)。 */
  onConfirm: (cids: string[]) => void
  /** Open the create-group flow, then forward into the new group (飞书式)。 */
  onCreateGroupForward: () => void
  onClose: () => void
}

/**
 * 消息转发选择器(P7-e):从已有会话里挑一个目标,把选中的消息重发过去。
 * 单选 + 发送两步,避免误点直接外发;搜索按会话名过滤。
 */
export const ForwardDialog = ({
  conversations,
  previewText,
  onConfirm,
  onCreateGroupForward,
  onClose,
}: Props) => {
  const { t } = useTranslation('im')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const searchRef = useRef<HTMLInputElement>(null)
  const toggle = (cid: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(cid)) next.delete(cid)
      else next.add(cid)
      return next
    })

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return conversations
    return conversations.filter((c) => c.name.toLowerCase().includes(q))
  }, [conversations, query])

  return (
    <Modal
      onClose={onClose}
      ariaLabel={t('forward.title')}
      initialFocusRef={searchRef}
      maxWidth="420px"
    >
      <div className={headerCls}>
        <h2 className={titleCls}>{t('forward.title')}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('group.cancel')}
          className={closeCls}
        >
          ×
        </button>
      </div>

      <div className={previewCls} title={previewText}>
        {previewText}
      </div>

      <div className={css({ padding: '0.5rem 1rem' })}>
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('forward.searchPlaceholder')}
          data-testid="forward-search"
          className={inputCls}
        />
      </div>

      <button
        type="button"
        onClick={onCreateGroupForward}
        data-testid="forward-create-group"
        className={createGroupCls}
      >
        <span className={nameCls}>{t('forward.createGroup')}</span>
        <span aria-hidden="true" className={chevronCls}>
          ›
        </span>
      </button>

      <div className={css({ overflowY: 'auto', flex: 1, minHeight: '8rem' })}>
        {filtered.length === 0 ? (
          <p className={css({ padding: '1rem', color: 'greyscale.500' })}>
            {t('forward.empty')}
          </p>
        ) : (
          filtered.map((c) => {
            const active = selected.has(c.cid)
            return (
              <button
                key={c.cid}
                type="button"
                onClick={() => toggle(c.cid)}
                aria-pressed={active}
                data-testid={`forward-item-${c.cid}`}
                className={rowCls(active)}
              >
                <span className={checkboxCls(active)} aria-hidden="true">
                  {active ? '✓' : ''}
                </span>
                {c.isGroup ? (
                  <GroupAvatar members={c.members ?? []} size="2rem" />
                ) : (
                  <MemberAvatar name={c.name} src={c.avatarUrl} size="2rem" />
                )}
                <span className={nameCls}>{c.name}</span>
              </button>
            )
          })
        )}
      </div>

      <div className={footerCls}>
        <button
          type="button"
          disabled={selected.size === 0}
          onClick={() => selected.size > 0 && onConfirm([...selected])}
          data-testid="forward-send"
          className={sendCls(selected.size > 0)}
        >
          {selected.size > 0
            ? t('forward.sendCount', { count: selected.size })
            : t('forward.send')}
        </button>
      </div>
    </Modal>
  )
}

const headerCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingX: '1rem',
  paddingY: '0.75rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})

const titleCls = css({
  margin: 0,
  fontSize: '1rem',
  fontWeight: 'bold',
  color: 'greyscale.900',
})

const closeCls = css({
  border: 'none',
  background: 'transparent',
  fontSize: '1.25rem',
  lineHeight: 1,
  cursor: 'pointer',
  color: 'greyscale.600',
})

const previewCls = css({
  margin: '0.75rem 1rem 0',
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  borderRadius: '0.5rem',
  backgroundColor: 'greyscale.100',
  color: 'greyscale.700',
  fontSize: '0.8125rem',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})

const inputCls = css({
  width: '100%',
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.5rem',
  fontSize: '0.875rem',
  outline: 'none',
  _focus: { borderColor: 'primary.500' },
})

const rowCls = (active: boolean) =>
  css({
    display: 'flex',
    alignItems: 'center',
    gap: '0.625rem',
    width: '100%',
    paddingX: '1rem',
    paddingY: '0.5rem',
    border: 'none',
    borderBottom: '1px solid token(colors.greyscale.100)',
    backgroundColor: active ? 'greyscale.100' : 'transparent',
    textAlign: 'left',
    cursor: 'pointer',
    _hover: { backgroundColor: 'greyscale.100' },
  })

const checkboxCls = (active: boolean) =>
  css({
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '1.25rem',
    height: '1.25rem',
    borderRadius: '999px',
    border: '1.5px solid',
    borderColor: active ? 'primary.500' : 'greyscale.400',
    backgroundColor: active ? 'primary.500' : 'transparent',
    color: 'white',
    fontSize: '0.75rem',
    lineHeight: 1,
  })

const nameCls = css({
  flex: 1,
  minWidth: 0,
  fontWeight: 'medium',
  color: 'greyscale.900',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})

const createGroupCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.625rem',
  width: '100%',
  paddingX: '1rem',
  paddingY: '0.75rem',
  border: 'none',
  borderBottom: '1px solid token(colors.greyscale.200)',
  backgroundColor: 'transparent',
  textAlign: 'left',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.100' },
})

const chevronCls = css({
  flexShrink: 0,
  color: 'greyscale.400',
  fontSize: '1.125rem',
  lineHeight: 1,
})

const footerCls = css({
  display: 'flex',
  justifyContent: 'flex-end',
  paddingX: '1rem',
  paddingY: '0.75rem',
  borderTop: '1px solid token(colors.greyscale.200)',
})

const sendCls = (enabled: boolean) =>
  css({
    paddingX: '1.25rem',
    paddingY: '0.5rem',
    border: 'none',
    borderRadius: '0.5rem',
    backgroundColor: enabled ? 'primary.500' : 'greyscale.300',
    color: 'white',
    fontSize: '0.875rem',
    fontWeight: 'medium',
    cursor: enabled ? 'pointer' : 'not-allowed',
  })
