import { useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/Modal'
import { Button, Text } from '@/primitives'
import { Select } from '@/primitives/Select'
import { DirectoryMultiPicker } from '@/features/contacts'
import { fetchApi } from '@/api/fetchApi'
import { css } from '@/styled-system/css'
import {
  summarySharingPath,
  type Access,
  type Grant,
  type Page,
  type Person,
  type SummarySharingWrite,
} from '../hooks/useSummarySharing'
import { receiptRole } from './liveRegionRole'

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
const grantsCls = css({
  listStyle: 'none',
  margin: 0,
  paddingX: 'lg',
  paddingBottom: 'md',
  display: 'flex',
  flexDirection: 'column',
  gap: 'xs',
  maxHeight: '10rem',
  overflowY: 'auto',
})

/**
 * 「成员与权限」弹窗 —— 分享转发之外的第二个入口,对标云文档的「邀请成员」。
 *
 * 与「分享转发」分开的理由是**决定粒度不同**:转发/链接是一句话的事(发给谁、
 * 发到哪),而成员与权限是「谁能看这份纪要、看到哪一层」的授权,需要先选人、
 * 看清影响、再确认,还要能撤销。混在同一个面板里,用户分不清自己点的是
 * 「发出去」还是「给了权限」。
 *
 * 面板复用通讯录多选([DirectoryMultiPicker]):通讯录由面板内置搜索提供,
 * 「本场实际参会人」作为第二个来源走后端的
 * `summary-sharing/candidates/` —— 只有对这条记录有可见性的人能被授权,
 * 所以「选错人」走不到确认那一步:预览会逐人给出授权前后的影响。
 */
export function SummaryMembersDialog({
  recordId,
  viewerId,
  online,
  available,
  supportedScopes,
  write,
  onResult,
  onClose,
}: {
  recordId: string
  viewerId: string
  online: boolean
  available: boolean
  supportedScopes: string[]
  write: SummarySharingWrite
  /** 一次写入落地(成功或给出确定回执)后回调,由面板刷新计数与回执。 */
  onResult: () => void
  onClose: () => void
}) {
  const { t } = useTranslation('meetings')
  const path = summarySharingPath(recordId)
  const { selection, preview, scope, pending, busy, blocked, message } = write
  const [selected, setSelected] = useState(new Map<string, string>())
  const [cursor, setCursor] = useState<string>()
  // 写入进行中不允许关闭 —— 关掉就等于把「结果未确认」藏起来。
  const running = useRef(false)
  running.current = busy
  const grants = useQuery({
    queryKey: ['summary-sharing-grants', viewerId, recordId, path, cursor],
    queryFn: ({ signal }) =>
      fetchApi<Access>(
        `${path}?${new URLSearchParams(cursor ? { cursor } : {})}`,
        { signal, cache: 'no-store' }
      ),
    retry: false,
    gcTime: 0,
    staleTime: 0,
  })
  const existing = grants.data?.results ?? []
  const close = () => {
    if (!running.current) onClose()
  }
  const transcript = scope === 'transcript'
  const scopeOf = (person: Grant) =>
    [
      person.read_summary && t('summarySharing.scopeSummary'),
      person.read_transcript && t('summarySharing.scopeTranscript'),
    ]
      .filter(Boolean)
      .join(' · ')
  // 候选来源在打开时组装一次即可:文案随语言变,来源集合随 online 变。
  const sources = useMemo(
    () => [
      ...(online
        ? [
            {
              value: 'participants',
              label: t('summarySharing.participants'),
              load: ({ query, cursor }: { query: string; cursor?: string }) =>
                fetchApi<Page<Person>>(
                  `${path}candidates/?${new URLSearchParams({
                    scope: 'participants',
                    q: query,
                    ...(cursor ? { cursor } : {}),
                  })}`,
                  { cache: 'no-store' }
                ),
            },
          ]
        : []),
      { value: 'directory', label: t('summarySharing.directory') },
    ],
    [online, path, t]
  )
  const confirm = async () => {
    if (blocked || busy) return
    // submit() 内部会在拿到确定结果(成功/冲突/被拒)时清掉未确认标记。
    // 这里读的是闭包里的旧值,所以按「提交之前有没有待核对的操作」来判:
    // 待核对的那一次无论成败都算有结果,一次全新的提交只有成功才算。
    const retrying = pending
    const applied = await write.submit()
    if (applied || retrying) {
      if (applied) setSelected(new Map())
      void grants.refetch()
      onResult()
    }
  }

  return (
    <Modal
      onClose={close}
      ariaLabel={t('summarySharing.members')}
      maxWidth="720px"
      maxHeight="86vh"
    >
      <ModalHeader
        title={t('summarySharing.members')}
        subtitle={t('summarySharing.membersHint')}
        onClose={close}
        closeLabel={t('summarySharing.close')}
      />
      <ModalBody
        padding="none"
        minHeight="20rem"
        className={css({ display: 'flex', flexDirection: 'column' })}
      >
        {blocked ? (
          <div className={css({ padding: 'lg' })}>
            <Text>{t('summarySharing.storageUnavailable')}</Text>
          </div>
        ) : preview ? (
          <div className={css({ padding: 'lg' })}>
            <div className={stack}>
              <h3>
                {t('summarySharing.previewTitle')} · {preview.title}
              </h3>
              <Text>
                {t(`summarySharing.operation.${selection.operation}`)}
              </Text>
              <ul className={stack}>
                {preview.recipients.map((person) => (
                  <li key={person.id}>
                    <strong>{person.name || t('summaryNotice.unnamed')}</strong>
                    <p>
                      {t(
                        transcript
                          ? person.after_effective_transcript
                            ? 'recordSharing.willRead'
                            : 'recordSharing.willLose'
                          : person.after_effective_summary
                            ? 'summarySharing.willRead'
                            : 'summarySharing.willLose'
                      )}
                    </p>
                    {(transcript
                      ? person.inherited_transcript
                      : person.inherited_summary) && (
                      <p>
                        {t(
                          transcript
                            ? 'recordSharing.inherited'
                            : 'summarySharing.inherited'
                        )}
                      </p>
                    )}
                    {!transcript && person.effective_transcript && (
                      <p>{t('summarySharing.originalAccess')}</p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : pending ? (
          <div className={css({ padding: 'lg' })}>
            <div className={stack}>
              <Text>
                {t('summarySharing.pending', { count: write.pendingCount })}
              </Text>
              <Text variant="note">{t('summarySharing.pendingResubmit')}</Text>
            </div>
          </div>
        ) : (
          <>
            {/* 选人面板自己铺满剩余高度(flex:1 + minHeight:0),「已有直接
                授权」跟随在下方 —— 不加这层包裹的话面板在滚动容器里会被压成
                0 高,列表一条都看不见。 */}
            <div
              className={css({
                display: 'flex',
                flexDirection: 'column',
                flex: 1,
                minHeight: 0,
              })}
            >
              <DirectoryMultiPicker
                selected={selected}
                testIdPrefix="summary-sharing-picker-"
                searchTestId="summary-sharing-picker-search"
                sources={sources}
                sourceLabel={t('summarySharing.recipientSource')}
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
                  searchPlaceholder: t('summarySharing.search'),
                  selectedTitle: t('summarySharing.selected', {
                    count: selected.size,
                  }),
                  loading: t('loading'),
                  empty: t('summarySharing.noCandidates'),
                  loadMore: t('library.next'),
                }}
              />
            </div>
            {/* 已有直接授权:一行一人,点名字即预览撤销(撤销同样是「先看影响
                再确认」的两步,不复用选人那套勾选)。 */}
            {!!existing.length && (
              <div className={css({ flexShrink: 0 })}>
                <h4
                  className={css({
                    paddingX: 'lg',
                    textStyle: 'labelLarge',
                    color: 'text.secondary',
                  })}
                >
                  {t('summarySharing.existing')}
                </h4>
                <ul className={grantsCls}>
                  {existing.map((person) => {
                    const revocable =
                      person.read_summary || person.read_transcript
                    return (
                      <li key={person.id}>
                        <Button
                          size="sm"
                          variant="secondaryText"
                          isDisabled={running.current || !revocable}
                          onPress={() =>
                            void write.inspect({
                              user_ids: [person.id],
                              operation: 'revoke',
                              // 撤销永远先按纪要授权预览;原文授权按行上标注的
                              // 范围逐层撤销,不在这里顺手连带。
                              access_scope: 'summary',
                            })
                          }
                        >
                          {person.name || t('summaryNotice.unnamed')}
                          {` · ${scopeOf(person)}`}
                          {!person.active &&
                            ` · ${t('summarySharing.inactive')}`}
                        </Button>
                      </li>
                    )
                  })}
                </ul>
                {grants.data?.next_cursor && (
                  <div className={css({ paddingX: 'lg', paddingBottom: 'md' })}>
                    <Button
                      size="sm"
                      variant="tertiary"
                      isDisabled={running.current}
                      onPress={() => setCursor(grants.data!.next_cursor!)}
                    >
                      {t('library.next')}
                    </Button>
                  </div>
                )}
                {cursor && (
                  <div className={css({ paddingX: 'lg', paddingBottom: 'md' })}>
                    <Button
                      size="sm"
                      variant="tertiary"
                      isDisabled={running.current}
                      onPress={() => setCursor(undefined)}
                    >
                      {t('recordAi.firstPage')}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </ModalBody>
      <div
        className={css({
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 'sm',
          paddingX: 'lg',
          paddingY: 'md',
          borderTop: '1px solid token(colors.border.subtle)',
        })}
      >
        {!available && <Text>{t('summarySharing.paused')}</Text>}
        {!pending && (
          <>
            {!preview && supportedScopes.includes('transcript') && (
              <Select
                aria-label={t('recordSharing.scope')}
                label={
                  <span className={css({ textStyle: 'labelMedium' })}>
                    {t('recordSharing.scope')}
                  </span>
                }
                selectedKey={selection.access_scope ?? 'summary'}
                isDisabled={busy}
                items={[
                  { value: 'summary', label: t('recordSharing.summary') },
                  {
                    value: 'transcript',
                    label: t('recordSharing.transcript'),
                  },
                ]}
                onSelectionChange={(key) => {
                  if (key !== 'summary' && key !== 'transcript') return
                  write.setSelection({
                    user_ids: [],
                    operation: 'grant',
                    access_scope: key,
                  })
                }}
              />
            )}
            {/* 边界说明在预览态也要留着:预览里的「可读/将失去」是在这一层范围
                下算的,把范围收掉会让人以为它管的是整条记录。 */}
            <Text variant="note">
              {t(
                transcript
                  ? 'recordSharing.boundaries'
                  : 'summarySharing.boundaries'
              )}
            </Text>
          </>
        )}
        <div className={line}>
          {pending ? (
            <Button
              size="sm"
              loading={busy}
              isDisabled={busy}
              onPress={() => void confirm()}
            >
              {t('summarySharing.resubmit')}
            </Button>
          ) : preview ? (
            <>
              <Button
                size="sm"
                loading={busy}
                isDisabled={busy || !available}
                onPress={() => void confirm()}
              >
                {t('summarySharing.confirm')}
              </Button>
              <Button
                size="sm"
                variant="tertiary"
                isDisabled={busy}
                onPress={() => write.setPreview(undefined)}
              >
                {t('summarySharing.back')}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              isDisabled={busy || !available || !selected.size}
              onPress={() =>
                void write.inspect({
                  user_ids: [...selected.keys()],
                  operation: 'grant',
                  access_scope: selection.access_scope,
                })
              }
            >
              {t('summarySharing.preview')}
            </Button>
          )}
          {!busy && selected.size > 0 && !preview && !pending && (
            <Button
              size="sm"
              variant="tertiary"
              onPress={() => setSelected(new Map())}
            >
              {t('summarySharing.clear')}
            </Button>
          )}
        </div>
        {message && <div role={receiptRole(message)}>{message}</div>}
      </div>
      <ModalFooter>
        <Button variant="secondary" size="action" onPress={close}>
          {t('summarySharing.done')}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
