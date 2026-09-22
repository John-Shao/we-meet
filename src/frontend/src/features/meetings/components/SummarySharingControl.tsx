import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { fetchApi } from '@/api/fetchApi'
import { Button, Text } from '@/primitives'
import { css } from '@/styled-system/css'
import { SummaryMembersDialog } from './SummaryMembersDialog'
import { SummaryShareToChatDialog } from './SummaryShareToChatDialog'
import { receiptRole } from './liveRegionRole'
import {
  summarySharingPath,
  useSummarySharing,
  type Access,
  type Grant,
} from '../hooks/useSummarySharing'

type Props = {
  recordId: string
  viewerId: string
  online: boolean
  title?: string
  originAt?: string | null
}

const stack = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'md',
  minWidth: 0,
  overflowWrap: 'anywhere',
})
const line = css({
  display: 'flex',
  gap: 'md',
  flexWrap: 'wrap',
  alignItems: 'center',
})
const section = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'sm',
  minWidth: 0,
  paddingY: 'md',
  borderTop: '1px solid token(colors.border.subtle)',
  _first: { borderTop: 'none', paddingTop: 0 },
})

export const SummarySharingControl = (props: Props) => (
  <Control key={`${props.viewerId}:${props.recordId}`} {...props} />
)

/**
 * 「分享」面板 —— 把两件粒度不同的事分开:
 *
 * 1. **分享转发**:把这条记录发出去(分享到聊天 / 复制链接)。只回答「怎么给到
 *    别人」,不改变任何人的权限。
 * 2. **协作管理**:谁能看、看到哪一层 —— 逐人授权/撤销,带影响预览与确认。
 *
 * 原先两块混在一个竖列里(选人 → 预览 → 确认 → 授权列表 → 复制链接),用户分不清
 * 自己点的是「发出去」还是「给了权限」;权限那几条安全约束(预览哈希、幂等键、
 * 未确认回执)也被夹在转发按钮中间。分开后,协作管理整体交给一个弹窗
 * ([SummaryMembersDialog],与云文档「邀请成员」同形态),选人面板复用通讯录多选。
 */
function Control({ recordId, viewerId, online, title, originAt }: Props) {
  const { t } = useTranslation('meetings')
  const [membersOpen, setMembersOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [message, setMessage] = useState('')
  const path = summarySharingPath(recordId)
  const query = useQuery({
    queryKey: ['summary-sharing', viewerId, recordId, path],
    queryFn: ({ signal }) =>
      fetchApi<Access>(path, { signal, cache: 'no-store' }),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchInterval: (q) => (q.state.status === 'error' ? false : 5000),
  })
  const write = useSummarySharing({ recordId, viewerId, path })
  if (query.isError)
    return (
      <div className={stack}>
        <Text>{t('summarySharing.loadError')}</Text>
        <Button
          size="sm"
          variant="tertiary"
          onPress={() => void query.refetch()}
        >
          {t('recordAi.refresh')}
        </Button>
      </div>
    )
  if (!query.data?.can_manage) return null
  const data = query.data
  const count = data.results.length
  const revocable = data.results.filter(
    (person: Grant) => person.read_summary || person.read_transcript
  ).length
  // 弹窗打开时回执由弹窗显示(它才是那一刻的焦点);关闭后由本面板接着显示。
  const receipt = membersOpen ? '' : message || write.message
  return (
    <section className={stack} aria-label={t('summarySharing.title')}>
      <div className={section}>
        <h3>{t('summarySharing.forward')}</h3>
        <Text variant="note">{t('summarySharing.forwardHint')}</Text>
        <div className={line}>
          <Button size="sm" onPress={() => setChatOpen(true)}>
            {t('summarySharing.chat')}
          </Button>
          <Button
            size="sm"
            variant="tertiary"
            onPress={() =>
              void navigator.clipboard
                .writeText(
                  `${location.origin}/meeting/records/${encodeURIComponent(recordId)}`
                )
                .then(
                  () => setMessage(t('summarySharing.copied')),
                  () => setMessage(t('summarySharing.copyError'))
                )
            }
          >
            {t('summarySharing.copyLink')}
          </Button>
        </div>
        <Text variant="note">{t('summarySharing.copyHint')}</Text>
      </div>
      <div className={section}>
        <h3>{t('summarySharing.collaboration')}</h3>
        <Text>
          {t(count ? 'summarySharing.granted' : 'summarySharing.noGrants', {
            count,
          })}
        </Text>
        <Text variant="note">{t('summarySharing.collaborationHint')}</Text>
        {!data.available && <Text>{t('summarySharing.paused')}</Text>}
        {write.pending && (
          <Text>
            {t('summarySharing.pending', { count: write.pendingCount })}
          </Text>
        )}
        {write.blocked && <Text>{t('summarySharing.storageUnavailable')}</Text>}
        <div className={line}>
          {write.pending && (
            <Button
              size="sm"
              loading={write.busy}
              isDisabled={write.busy}
              onPress={() => void write.submit()}
            >
              {t('summarySharing.resubmit')}
            </Button>
          )}
          <Button
            size="sm"
            isDisabled={!data.available || write.blocked}
            onPress={() => {
              setMessage('')
              setMembersOpen(true)
            }}
          >
            {t('summarySharing.members')}
          </Button>
        </div>
        {!revocable && count > 0 && (
          <Text variant="note">{t('summarySharing.originalAccess')}</Text>
        )}
      </div>
      {receipt && <div role={receiptRole(receipt)}>{receipt}</div>}
      {membersOpen && (
        <SummaryMembersDialog
          recordId={recordId}
          viewerId={viewerId}
          online={online}
          available={data.available}
          supportedScopes={data.supported_scopes ?? []}
          write={write}
          onResult={() => void query.refetch()}
          onClose={() => setMembersOpen(false)}
        />
      )}
      {chatOpen && (
        <SummaryShareToChatDialog
          recordId={recordId}
          title={title || t('home.untitled')}
          originAt={originAt}
          onClose={() => setChatOpen(false)}
        />
      )}
    </section>
  )
}
