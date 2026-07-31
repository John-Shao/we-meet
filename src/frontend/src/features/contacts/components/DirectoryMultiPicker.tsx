import { type RefObject } from 'react'

import { css } from '@/styled-system/css'
import { StateHint } from '@/components/StateHint'

import { useDirectoryMemberSearch } from '../hooks/useDirectoryMemberSearch'
import { MemberAvatar } from './MemberAvatar'

export interface DirectoryMultiPickerLabels {
  searchPlaceholder: string
  /** 右栏标题,通常是「已选 N 人」——由调用方按自己的命名空间格式化。 */
  selectedTitle: string
  loading: string
  empty: string
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
}: Props) => {
  const { query, setQuery, selectable, isFetching } = useDirectoryMemberSearch()
  const options = excludeIds
    ? selectable.filter((m) => !excludeIds.has(m.id))
    : selectable

  return (
    <div className={bodyCls}>
      <div className={leftCls}>
        <div className={css({ padding: '0.75rem 1rem' })}>
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={labels.searchPlaceholder}
            data-testid={searchTestId}
            className={inputCls}
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
          {isFetching && options.length === 0 ? (
            <StateHint loading>{labels.loading}</StateHint>
          ) : options.length === 0 ? (
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
        </div>
      </div>

      <div className={rightCls}>
        <div className={rightTitleCls}>{labels.selectedTitle}</div>
        <ul className={rightListCls}>
          {locked && <Chip label={locked.label} />}
          {[...selected.entries()].map(([id, label]) => (
            <Chip key={id} label={label} onRemove={() => onToggle(id, label)} />
          ))}
        </ul>
      </div>
    </div>
  )
}

const bodyCls = css({ display: 'flex', flex: 1, minHeight: 0 })

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
})

const rightTitleCls = css({
  padding: '0.75rem 1rem 0.25rem',
  fontSize: '0.8125rem',
  color: 'greyscale.600',
})

const rightListCls = css({
  listStyle: 'none',
  margin: 0,
  padding: '0 0.5rem',
  overflowY: 'auto',
  flex: 1,
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
  <button
    type="button"
    onClick={onToggle}
    disabled={disabled}
    aria-pressed={checked}
    data-testid={testid}
    className={css({
      display: 'flex',
      alignItems: 'center',
      gap: '0.625rem',
      width: '100%',
      paddingX: '1rem',
      paddingY: '0.5rem',
      border: 'none',
      borderBottom: '1px solid token(colors.greyscale.100)',
      backgroundColor: checked ? 'greyscale.100' : 'transparent',
      textAlign: 'left',
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.6 : 1,
      _hover: { backgroundColor: disabled ? undefined : 'greyscale.100' },
    })}
  >
    <span
      aria-hidden="true"
      className={css({
        flexShrink: 0,
        width: '1.125rem',
        height: '1.125rem',
        borderRadius: '0.25rem',
        border: '1px solid token(colors.greyscale.400)',
        // 未选中用会翻转的 greyscale.000(浅色仍是纯白),裸 'white' 在深色下
        // 是一排刺眼的白方块。
        backgroundColor: checked ? 'primary.500' : 'greyscale.000',
        color: 'white',
        fontSize: '0.75rem',
        lineHeight: '1.125rem',
        textAlign: 'center',
      })}
    >
      {checked ? '✓' : ''}
    </span>
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
  </button>
)

const Chip = ({
  label,
  onRemove,
}: {
  label: string
  onRemove?: () => void
}) => (
  <li
    className={css({
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '0.5rem',
      paddingX: '0.5rem',
      paddingY: '0.375rem',
      borderRadius: '0.375rem',
      _hover: { backgroundColor: 'greyscale.50' },
    })}
  >
    <span
      className={css({
        fontSize: '0.8125rem',
        color: 'greyscale.800',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      })}
    >
      {label}
    </span>
    {onRemove ? (
      <button
        type="button"
        onClick={onRemove}
        aria-label="remove"
        className={css({
          flexShrink: 0,
          border: 'none',
          background: 'transparent',
          color: 'greyscale.500',
          cursor: 'pointer',
          fontSize: '0.875rem',
          _hover: { color: 'error.500' },
        })}
      >
        ×
      </button>
    ) : null}
  </li>
)
