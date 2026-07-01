import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import { Modal } from '@/components/Modal'

import { Avatar } from './Avatar'

/** One roster entry as seen by the read/unread list. */
export interface ReadReceiptMember {
  uid: string
  name: string
  /** presigned avatar url; undefined → tinted initial. */
  avatarUrl?: string
}

interface Props {
  /** Members who have read the target message (seq ≤ their last_read_seq). */
  read: ReadReceiptMember[]
  /** Members who have not yet read it. */
  unread: ReadReceiptMember[]
  onClose: () => void
}

/**
 * 群聊已读名单(P13, D2):点开某条自己发的消息的「N 人已读」,分「已读 / 未读」
 * 两个分栏列出成员。纯展示,不改任何服务端状态。
 */
export const ReadReceiptList = ({ read, unread, onClose }: Props) => {
  const { t } = useTranslation('im')
  const [tab, setTab] = useState<'read' | 'unread'>('read')
  const list = tab === 'read' ? read : unread

  return (
    <Modal onClose={onClose} ariaLabel={t('read.listTitle')} maxWidth="360px">
      <div className={headerCls}>
        <h2 className={titleCls}>{t('read.listTitle')}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('group.cancel')}
          className={closeCls}
        >
          ×
        </button>
      </div>

      <div className={tabsCls} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'read'}
          onClick={() => setTab('read')}
          data-testid="read-tab-read"
          className={tabCls(tab === 'read')}
        >
          {t('read.tabRead', { count: read.length })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'unread'}
          onClick={() => setTab('unread')}
          data-testid="read-tab-unread"
          className={tabCls(tab === 'unread')}
        >
          {t('read.tabUnread', { count: unread.length })}
        </button>
      </div>

      <div className={css({ overflowY: 'auto', flex: 1, minHeight: '8rem' })}>
        {list.length === 0 ? (
          <p className={css({ padding: '1rem', color: 'greyscale.500', fontSize: '0.875rem' })}>
            {tab === 'read' ? t('read.emptyRead') : t('read.emptyUnread')}
          </p>
        ) : (
          list.map((m) => (
            <div key={m.uid} className={rowCls} data-testid={`read-member-${m.uid}`}>
              <Avatar name={m.name} src={m.avatarUrl} size="2rem" />
              <span className={nameCls}>{m.name}</span>
            </div>
          ))
        )}
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

const tabsCls = css({
  display: 'flex',
  gap: '0.5rem',
  paddingX: '1rem',
  paddingTop: '0.75rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})

const tabCls = (active: boolean) =>
  css({
    paddingX: '0.25rem',
    paddingBottom: '0.5rem',
    border: 'none',
    borderBottom: '2px solid',
    borderColor: active ? 'primary.500' : 'transparent',
    background: 'transparent',
    fontSize: '0.875rem',
    fontWeight: active ? 'bold' : 'medium',
    color: active ? 'primary.700' : 'greyscale.600',
    cursor: 'pointer',
  })

const rowCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.625rem',
  paddingX: '1rem',
  paddingY: '0.5rem',
  borderBottom: '1px solid token(colors.greyscale.100)',
})

const nameCls = css({
  flex: 1,
  minWidth: 0,
  fontSize: '0.875rem',
  color: 'greyscale.900',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})
