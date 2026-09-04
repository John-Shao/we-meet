import { RiCloseLine } from '@remixicon/react'
import { type RefObject, useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'

import { css } from '@/styled-system/css'
import { StateHint } from '@/components/StateHint'
import { IconButton, Input, SelectableListRow } from '@/primitives'

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
}

/**
 * 通讯录多选面板(左搜索勾选 + 右已选)—— 「新建群聊」与日历「批量添加参与者」
 * 共用的那块中间区域。只管选人,不含标题栏/底部动作条:标题与「创建 / 确定」
 * 由各自的对话框拼在外面,因为两处的落地动作本就不同。
 *
 * 文案由调用方以 [labels] 传入 —— 这个组件被 im / calendar 两个命名空间共用,
 * 自己持有 useTranslation 反而要在里面挑命名空间。
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
  } = useDirectoryMemberSearch({ includeSelf })
  const { data: externalContacts = [], isFetching: isFetchingExternal } =
    useQuery({
      queryKey: ['directory', 'external-contacts'],
      queryFn: fetchExternalContacts,
      enabled: includeExternal,
      staleTime: 30_000,
    })
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
      includeExternal
        ? externalContacts.filter((contact) => {
            if (excludeIds?.has(contact.id)) return false
            if (!normalizedQuery) return true
            return [
              contact.full_name,
              contact.short_name,
              contact.organization?.name,
            ].some((value) => value?.toLowerCase().includes(normalizedQuery))
          })
        : [],
    [excludeIds, externalContacts, includeExternal, normalizedQuery]
  )
  const empty = options.length === 0 && externalOptions.length === 0
  const visibleAvatars = useMemo(
    () =>
      new Map(
        [...options, ...externalOptions]
          .filter((member) => Boolean(member.avatar_url))
          .map((member) => [member.id, member.avatar_url as string])
      ),
    [externalOptions, options]
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
  }, [externalOptions, options])

  return (
    <div className={bodyCls}>
      <div className={leftCls}>
        <div className={css({ padding: '0.75rem 1rem' })}>
          <Input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={labels.searchPlaceholder}
            data-testid={searchTestId}
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
          {(isFetching || isFetchingExternal) && empty ? (
            <StateHint state="loading">{labels.loading}</StateHint>
          ) : empty ? (
            <StateHint>{labels.empty}</StateHint>
          ) : (
            options.map((m) => {
              const label = m.full_name || m.short_name || m.email || m.id
              return (
                <Row
                  key={m.id}
                  testid={testIdPrefix ? `${testIdPrefix}${m.id}` : undefined}
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
          )}
          {externalOptions.map((contact) => {
            const label = contact.full_name || contact.short_name || contact.id
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
                onToggle={() => onToggle(contact.id, label, contact.avatar_url)}
              />
            )
          })}
          {hasNextPage && (
            <button
              type="button"
              onClick={() => fetchNextPage()}
              disabled={isFetchingNextPage}
              className={loadMoreCls}
            >
              {isFetchingNextPage ? labels.loading : labels.loadMore}
            </button>
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
  borderRight: '1px solid token(colors.greyscale.200)',
})

const rightCls = css({
  width: '40%',
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  backgroundColor: 'surface.canvas',
})

const rightTitleCls = css({
  flexShrink: 0,
  paddingX: 'md',
  paddingY: 'sm',
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
  <SelectableListRow
    onClick={onToggle}
    disabled={disabled}
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
