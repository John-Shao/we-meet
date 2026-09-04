import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { css } from '@/styled-system/css'
import { Modal, ModalBody, ModalHeader } from '@/components/Modal'
import { StateHint } from '@/components/StateHint'
import { SegmentedControl } from '@/primitives'

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
      <ModalHeader
        title={t('read.listTitle')}
        onClose={onClose}
        closeLabel={t('group.cancel')}
      />

      <SegmentedControl
        value={tab}
        items={[
          {
            id: 'read',
            label: t('read.tabRead', { count: read.length }),
            testId: 'read-tab-read',
          },
          {
            id: 'unread',
            label: t('read.tabUnread', { count: unread.length }),
            testId: 'read-tab-unread',
          },
        ]}
        onChange={setTab}
        ariaLabel={t('read.listTitle')}
        className={tabsCls}
      />

      <ModalBody padding="none" minHeight="8rem">
        {list.length === 0 ? (
          <StateHint>
            {tab === 'read' ? t('read.emptyRead') : t('read.emptyUnread')}
          </StateHint>
        ) : (
          list.map((m) => (
            <div
              key={m.uid}
              className={rowCls}
              data-testid={`read-member-${m.uid}`}
            >
              <Avatar name={m.name} src={m.avatarUrl} size="2rem" />
              <span className={nameCls}>{m.name}</span>
            </div>
          ))
        )}
      </ModalBody>
    </Modal>
  )
}

const tabsCls = css({
  gap: '0.5rem',
  paddingX: '1rem',
  paddingTop: '0.75rem',
  borderBottom: '1px solid token(colors.border.default)',
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
