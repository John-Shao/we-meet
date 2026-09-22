import { RiCloseLine } from '@remixicon/react'
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { css } from '@/styled-system/css'
import { StateHint } from '@/components/StateHint'
import { IconButton, SearchBox, SelectableListRow } from '@/primitives'
import { Select } from '@/primitives/Select'

import { useDirectoryMemberSearch } from '../hooks/useDirectoryMemberSearch'
import { fetchExternalContacts } from '../api/externalContacts'
import { MemberAvatar } from './MemberAvatar'

export interface DirectoryMultiPickerLabels {
  searchPlaceholder: string
  /** 右栏标题,通常是「已选 N 人」——由调用方按自己的命名空间格式化。 */
  selectedTitle: string
  loading: string
  empty: string
  /** 「加载更多」——超过一页(100 人)时才出现。 */
  loadMore: string
}

/** 一个可搜到的候选:[query] 是已防抖的关键词,[cursor] 为空表示第一页。 */
export interface DirectoryPickerQuery {
  query: string
  cursor?: string
}

/**
 * 除通讯录之外的候选来源。存在的理由:有些授权流程**只能**在业务自己的
 * 候选集里选人 —— 例如纪要分享只允许授权给有记录可见性的人,而通讯录里
 * 任何人都搜得到。让候选集成为参数,复用面板本身(搜索/已选/分页/无障碍),
 * 好过每个业务各写一个「长得差不多」的选人面板。
 */
export interface DirectoryPickerSource {
  value: string
  label: string
  /** 省略 = 走内置通讯录搜索(含外部联系人)。 */
  load?: (
    params: DirectoryPickerQuery
  ) => Promise<{ results: DirectoryPickerRow[]; next_cursor?: string | null }>
}

/** 一行的最小形状:业务来源的 [load] 返回它,面板只映射 id/name/头像。 */
export interface DirectoryPickerRow {
  id: string
  name: string
  avatar_url?: string | null
  [key: string]: unknown
}

interface Props {
  /** 受控选择:id → 显示名(名字在勾选那刻捕获,换关键词后 chips 仍有名字)。 */
  selected: Map<string, string>
  /** 第三个参数是该成员的头像 URL(勾选那刻捕获);不需要的调用方可无视。 */
  onToggle: (id: string, label: string, avatarUrl?: string) => void
  labels: DirectoryMultiPickerLabels
  /** 列表顶部的锁定行(如群主自己):恒勾选、不可取消。 */
  locked?: { label: string; sub?: string; avatarSrc?: string | null }
  /** 不出现在候选里的人(如已在群里的成员)。 */
  excludeIds?: Set<string>
  /** 列表项 data-testid 前缀,如 `group-picker-item-`。 */
  testIdPrefix?: string
  searchTestId?: string
  searchRef?: RefObject<HTMLInputElement>
  /** Calendar/IM pickers may include already accepted external accounts. */
  includeExternal?: boolean
  externalLabel?: string
  /** Flows such as task followers may allow selecting the current user. */
  includeSelf?: boolean
  /**
   * 候选来源。默认只有一个「通讯录」(value `directory`,走内置搜索)。
   * 传多个时左栏顶部出现来源切换。
   */
  sources?: DirectoryPickerSource[]
  /** 来源切换的标题;缺省不渲染标题。 */
  sourceLabel?: string
}

/**
 * 通讯录多选面板(左搜索勾选 + 右已选)—— 「新建群聊」与日历「批量添加参与者」
 * 共用的那块中间区域。只管选人,不含标题栏/底部动作条:标题与「创建 / 确定」
 * 由各自的对话框拼在外面,因为两处的落地动作本就不同。
 *
 * 文案由调用方以 [labels] 传入 —— 这个组件被 im / calendar 两个命名空间共用,
 * 自己持有 useTranslation 反而要在里面挑命名空间。
 *
 * 候选集默认是通讯录;需要「只能在业务候选里授权」的调用方用 [sources] 传入
 * 自己的来源 + [renderRowMeta],不必再抄一份面板。
 */
export const DirectoryMultiPicker = ({
  selected,
  onToggle,
  labels,
  locked,
  excludeIds,
  testIdPrefix,
  searchRef,
  searchTestId,
  includeExternal = false,
  externalLabel = 'External',
  includeSelf = false,
  sources,
  sourceLabel,
}: Props) => {
  const { t } = useTranslation('contacts')
  const {
    query,
    setQuery,
    selectable,
    isFetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isError,
    refetch,
  } = useDirectoryMemberSearch({ includeSelf })
  const { data: externalContacts = [], isFetching: isFetchingExternal } =
    useQuery({
      queryKey: ['directory', 'external-contacts'],
      queryFn: fetchExternalContacts,
      enabled: includeExternal,
      staleTime: 30_000,
    })
  // 不给 sources = 只有通讯录,且支持外部联系人(与存量调用方完全一致)。
  const tabs = useMemo<DirectoryPickerSource[]>(
    () => (sources?.length ? sources : [{ value: 'directory', label: '' }]),
    [sources]
  )
  const [sourceValue, setSourceValue] = useState(tabs[0].value)
  const active = tabs.find((tab) => tab.value === sourceValue) ?? tabs[0]
  const directory = !active.load
  // 每个来源各自翻页,切回来不会串页;`set` 只在下次取值时读,无需更新函数式。
  const [cursors, setCursors] = useState<Record<string, string | undefined>>({})
  const cursor = cursors[active.value]
  const custom = useQuery({
    // `active.load` 也进 key(而不仅是 active.value):来源的身份由「名字 +
    // 取数函数」共同决定,换掉函数就该重新取,别命中上一个来源的缓存。
    queryKey: [
      'directory',
      'picker-source',
      active.value,
      active.load,
      cursor,
      query,
    ],
    queryFn: () => active.load!({ query: query.trim(), cursor }),
    enabled: !directory,
    staleTime: 0,
  })
  const customFailed = custom.isError
  const customRows = useMemo<DirectoryPickerRow[]>(
    () => custom.data?.results ?? [],
    [custom.data]
  )
  const options = useMemo(
    () =>
      excludeIds
        ? selectable.filter((member) => !excludeIds.has(member.id))
        : selectable,
    [excludeIds, selectable]
  )
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const externalOptions = useMemo(
    () =>
      !directory || !includeExternal
        ? []
        : externalContacts.filter((contact) => {
            if (excludeIds?.has(contact.id)) return false
            if (!normalizedQuery) return true
            return [
              contact.full_name,
              contact.short_name,
              contact.organization?.name,
            ].some((value) => value?.toLowerCase().includes(normalizedQuery))
          }),
    [directory, excludeIds, externalContacts, includeExternal, normalizedQuery]
  )
  const failed = directory ? isError : customFailed
  const retry = () => (directory ? void refetch() : void custom.refetch())
  const listLength = directory
    ? options.length + externalOptions.length
    : customRows.length
  const pendingFirstPage = directory
    ? isFetching || isFetchingExternal
    : custom.isFetching
  // 只有「查询成功且真的没人」才算空 —— 失败/加载中各有自己的分支,
  // 否则错误态下会同时冒出「重试」和一个「没有匹配的用户」。
  const empty = !failed && !pendingFirstPage && listLength === 0
  const noMore = directory ? !hasNextPage : !custom.data?.next_cursor
  const loadingMore = directory ? isFetchingNextPage : custom.isFetching
  const visibleAvatars = useMemo(
    () =>
      new Map(
        [
          ...(directory
            ? [...options, ...externalOptions].map((member) => ({
                id: member.id,
                avatar_url: member.avatar_url,
              }))
            : customRows),
        ]
          .filter((member) => Boolean(member.avatar_url))
          .map((member) => [member.id, member.avatar_url as string])
      ),
    [customRows, directory, externalOptions, options]
  )
  // Keep avatars for selected people when a new search replaces the visible
  // result page. The selected Map intentionally stays id -> label for callers.
  const avatarCacheRef = useRef(new Map<string, string>())
  useEffect(() => {
    for (const member of options) {
      if (member.avatar_url) {
        avatarCacheRef.current.set(member.id, member.avatar_url)
      }
    }
    for (const contact of externalOptions) {
      if (contact.avatar_url) {
        avatarCacheRef.current.set(contact.id, contact.avatar_url)
      }
    }
    for (const member of customRows) {
      if (member.avatar_url) {
        avatarCacheRef.current.set(member.id, member.avatar_url)
      }
    }
  }, [customRows, externalOptions, options])

  return (
    <div className={bodyCls}>
      <div className={leftCls}>
        {tabs.length > 1 && (
          <div className={sourceRowCls}>
            <Select
              aria-label={sourceLabel}
              label={
                sourceLabel ? (
                  <span className={css({ textStyle: 'labelMedium' })}>
                    {sourceLabel}
                  </span>
                ) : undefined
              }
              selectedKey={active.value}
              items={tabs.map((tab) => ({
                value: tab.value,
                label: tab.label,
              }))}
              onSelectionChange={(key) => {
                if (typeof key === 'string') setSourceValue(key)
              }}
            />
          </div>
        )}
        <div className={css({ paddingY: 'md', paddingX: 'lg' })}>
          <SearchBox
            value={query}
            onChange={setQuery}
            placeholder={labels.searchPlaceholder}
            testId={searchTestId}
            inputRef={searchRef}
          />
        </div>
        <div className={css({ overflowY: 'auto', flex: 1 })}>
          {locked && (
            <Row
              label={locked.label}
              sub={locked.sub}
              avatarSrc={locked.avatarSrc}
              checked
              disabled
            />
          )}
          {failed && (
            <StateHint state="error">
              <p>{t('picker.loadError')}</p>
              <button type="button" onClick={retry}>
                {t('picker.retry')}
              </button>
            </StateHint>
          )}
          {!failed && (pendingFirstPage || empty) ? (
            pendingFirstPage && listLength === 0 ? (
              <StateHint state="loading">{labels.loading}</StateHint>
            ) : (
              <StateHint>{labels.empty}</StateHint>
            )
          ) : (
            <>
              {directory
                ? options.map((m) => {
                    const label = m.full_name || m.short_name || m.email || m.id
                    return (
                      <Row
                        key={m.id}
                        testid={
                          testIdPrefix ? `${testIdPrefix}${m.id}` : undefined
                        }
                        label={label}
                        sub={[m.title, m.department?.name]
                          .filter(Boolean)
                          .join(' · ')}
                        avatarSrc={m.avatar_url}
                        checked={selected.has(m.id)}
                        onToggle={() => onToggle(m.id, label, m.avatar_url)}
                      />
                    )
                  })
                : customRows.map((m) => {
                    const label = m.name || m.id
                    return (
                      <SourceRow
                        key={m.id}
                        testid={
                          testIdPrefix ? `${testIdPrefix}${m.id}` : undefined
                        }
                        label={label}
                        avatarSrc={m.avatar_url}
                        checked={selected.has(m.id)}
                        onToggle={() =>
                          onToggle(m.id, label, m.avatar_url ?? undefined)
                        }
                      />
                    )
                  })}
              {externalOptions.map((contact) => {
                const label =
                  contact.full_name || contact.short_name || contact.id
                return (
                  <Row
                    key={`external-${contact.id}`}
                    testid={
                      testIdPrefix ? `${testIdPrefix}${contact.id}` : undefined
                    }
                    label={label}
                    sub={[contact.organization?.name, externalLabel]
                      .filter(Boolean)
                      .join(' · ')}
                    avatarSrc={contact.avatar_url}
                    checked={selected.has(contact.id)}
                    onToggle={() =>
                      onToggle(contact.id, label, contact.avatar_url)
                    }
                  />
                )
              })}
              {!noMore && (
                <button
                  type="button"
                  onClick={() =>
                    directory
                      ? void fetchNextPage()
                      : setCursors((prev) => ({
                          ...prev,
                          [active.value]: custom.data?.next_cursor ?? undefined,
                        }))
                  }
                  disabled={loadingMore}
                  className={loadMoreCls}
                >
                  {loadingMore ? labels.loading : labels.loadMore}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div className={rightCls}>
        <div className={rightTitleCls} aria-live="polite">
          {labels.selectedTitle}
        </div>
        <ul className={rightListCls}>
          {locked && (
            <li className={selectedChipRowCls}>
              <SelectedMember
                label={locked.label}
                avatarSrc={locked.avatarSrc}
                status={locked.sub}
              />
            </li>
          )}
          {[...selected.entries()].map(([id, label]) => (
            <li key={id} className={selectedChipRowCls}>
              <SelectedMember
                label={label}
                avatarSrc={
                  visibleAvatars.get(id) ?? avatarCacheRef.current.get(id)
                }
                removeLabel={`${t('picker.remove')}: ${label}`}
                onRemove={() => onToggle(id, label)}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

const bodyCls = css({ display: 'flex', flex: 1, minHeight: 0 })

const sourceRowCls = css({
  flexShrink: 0,
  paddingTop: 'md',
  paddingX: 'lg',
})

const loadMoreCls = css({
  width: '100%',
  padding: '0.625rem 1rem',
  textStyle: 'sm',
  color: 'primary.500',
  cursor: 'pointer',
  _hover: { bg: 'greyscale.100' },
  _disabled: { cursor: 'default', color: 'greyscale.500' },
})

const leftCls = css({
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minWidth: 0,
  borderRight: '1px solid token(colors.border.subtle)',
})

const rightCls = css({
  width: '40%',
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  paddingTop: 'md',
})

const rightTitleCls = css({
  display: 'flex',
  alignItems: 'center',
  minHeight: 'controlHeight.compact',
  flexShrink: 0,
  paddingX: 'md',
  paddingY: 'xs',
  borderBottom: '1px solid token(colors.border.subtle)',
  textStyle: 'labelMedium',
  fontWeight: 'medium',
  color: 'text.secondary',
})

const rightListCls = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'xs',
  listStyle: 'none',
  margin: 0,
  padding: 'sm',
  overflowY: 'auto',
  flex: 1,
})

const Row = ({
  label,
  sub,
  avatarSrc,
  checked,
  disabled,
  onToggle,
  testid,
}: {
  label: string
  sub?: string
  avatarSrc?: string | null
  checked?: boolean
  disabled?: boolean
  onToggle?: () => void
  testid?: string
}) => (
  <SourceRow
    label={label}
    sub={sub}
    avatarSrc={avatarSrc}
    checked={checked}
    onToggle={disabled ? undefined : onToggle}
    testid={testid}
  />
)

/**
 * 业务来源的行。与 [Row] 同一个 [SelectableListRow] 外壳(= 同一套 hover/
 * 选中/分隔线),差别只在「附加信息」是调用方给的节点(例如权限标记)
 * 而不是一行副标题字符串。
 */
const SourceRow = ({
  label,
  sub,
  avatarSrc,
  checked,
  onToggle,
  testid,
}: {
  label: string
  sub?: React.ReactNode
  avatarSrc?: string | null
  checked?: boolean
  onToggle?: () => void
  testid?: string
}) => (
  <SelectableListRow
    onClick={onToggle}
    disabled={!onToggle}
    isSelected={Boolean(checked)}
    data-testid={testid}
    divider
  >
    <MemberAvatar name={label} src={avatarSrc} size="2rem" />
    <span
      className={css({
        display: 'flex',
        flexDirection: 'column',
        gap: '0.125rem',
        minWidth: 0,
      })}
    >
      <span
        className={css({
          fontWeight: 'medium',
          color: 'greyscale.900',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        })}
      >
        {label}
      </span>
      {sub ? (
        <span className={css({ fontSize: '0.75rem', color: 'greyscale.500' })}>
          {sub}
        </span>
      ) : null}
    </span>
  </SelectableListRow>
)

const SelectedMember = ({
  label,
  avatarSrc,
  status,
  removeLabel,
  onRemove,
}: {
  label: string
  avatarSrc?: string | null
  status?: string
  removeLabel?: string
  onRemove?: () => void
}) => (
  <div className={selectedMemberCls}>
    <MemberAvatar name={label} src={avatarSrc} size="2rem" />
    <span className={selectedMemberNameCls} title={label}>
      {label}
    </span>
    {status ? <span className={selectedMemberStatusCls}>{status}</span> : null}
    {onRemove && removeLabel ? (
      <IconButton
        label={removeLabel}
        size="icon28"
        variant="quaternaryDanger"
        onPress={onRemove}
        className={removeButtonCls}
      >
        <RiCloseLine size={16} aria-hidden="true" />
      </IconButton>
    ) : null}
  </div>
)

const selectedChipRowCls = css({ minWidth: 0 })

const selectedMemberCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'sm',
  minWidth: 0,
  minHeight: '3rem',
  padding: 'sm',
  backgroundColor: 'surface.default',
  border: '1px solid token(colors.border.subtle)',
  borderRadius: 'control',
  boxShadow: 'subtle',
  transition:
    'border-color token(durations.fast), box-shadow token(durations.fast)',
  _hover: {
    borderColor: 'border.default',
    boxShadow: 'raised',
  },
})

const selectedMemberNameCls = css({
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  textStyle: 'bodyMedium',
  fontWeight: 'medium',
  color: 'text.primary',
})

const selectedMemberStatusCls = css({
  flexShrink: 0,
  paddingX: 'xs',
  paddingY: '0.125rem',
  borderRadius: 'pill',
  backgroundColor: 'action.selected.bg',
  color: 'action.selected.text',
  textStyle: 'labelSmall',
})

const removeButtonCls = css({
  flexShrink: 0,
})
