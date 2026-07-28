import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { css, cx } from '@/styled-system/css'
import { Modal } from '@/components/Modal'
import { useUser } from '@/features/auth'
import { DirectoryMultiPicker } from '@/features/contacts'

/**
 * Modal directory picker for creating a GROUP conversation (对标飞书):
 * the creator (self) is always selected and locked; other org members are
 * toggled on the left and shown as removable chips on the right. The chosen
 * member ids (excluding self — the backend adds the owner automatically) are
 * passed to `onCreate` along with an optional group name.
 */
interface Props {
  onCreate: (memberUserIds: string[], name: string) => void
  onClose: () => void
  /** Pre-selected members (we-meet user id → label), e.g. the peer when
   * creating a group from a 1-on-1 conversation. */
  initialMembers?: Array<{ id: string; label: string }>
}

export const GroupPicker = ({ onCreate, onClose, initialMembers }: Props) => {
  const { t } = useTranslation('im')
  const { user } = useUser()
  const [name, setName] = useState('')
  // id → display label, captured at toggle time so chips stay labelled even
  // after the search query (and thus the visible member list) changes.
  const [selected, setSelected] = useState<Map<string, string>>(
    () => new Map((initialMembers ?? []).map((m) => [m.id, m.label]))
  )
  const searchRef = useRef<HTMLInputElement>(null)

  const selfLabel = user?.full_name || user?.email || t('group.you')

  const toggle = (id: string, label: string) =>
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(id)) next.delete(id)
      else next.set(id, label)
      return next
    })

  const canCreate = selected.size > 0
  // count includes self (locked).
  const total = selected.size + 1

  return (
    <Modal
      onClose={onClose}
      ariaLabel={t('group.title')}
      maxWidth="640px"
      maxHeight="72vh"
      initialFocusRef={searchRef}
    >
      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingX: '1rem',
          paddingY: '0.75rem',
          borderBottom: '1px solid token(colors.greyscale.200)',
        })}
      >
        <h2
          className={css({
            margin: 0,
            fontSize: '1rem',
            fontWeight: 'bold',
            color: 'greyscale.900',
          })}
        >
          {t('group.title')}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('group.cancel')}
          className={css({
            border: 'none',
            background: 'transparent',
            fontSize: '1.25rem',
            lineHeight: 1,
            cursor: 'pointer',
            color: 'greyscale.600',
          })}
        >
          ×
        </button>
      </div>

      {/* 左搜索勾选 + 右已选 —— 与日历「批量添加参与者」共用同一块面板。 */}
      <DirectoryMultiPicker
        selected={selected}
        onToggle={toggle}
        labels={{
          searchPlaceholder: t('group.searchPlaceholder'),
          selectedTitle: t('group.selected', { count: total }),
          loading: t('group.loading'),
          empty: t('group.empty'),
        }}
        locked={{
          label: selfLabel,
          sub: t('group.you'),
          avatarSrc: user?.avatar_url,
        }}
        searchRef={searchRef}
        searchTestId="group-picker-search"
        testIdPrefix="group-picker-item-"
      />

      <div
        className={css({
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          paddingX: '1rem',
          paddingY: '0.75rem',
          borderTop: '1px solid token(colors.greyscale.200)',
        })}
      >
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('group.namePlaceholder')}
          data-testid="group-picker-name"
          className={cx(inputCls, css({ flex: 1, minWidth: 0 }))}
        />
        <button
          type="button"
          disabled={!canCreate}
          onClick={() => onCreate([...selected.keys()], name.trim())}
          data-testid="group-picker-create"
          className={css({
            flexShrink: 0,
            paddingX: '1rem',
            paddingY: '0.5rem',
            border: 'none',
            borderRadius: '0.5rem',
            backgroundColor: canCreate ? 'primary.500' : 'greyscale.300',
            color: 'white',
            fontSize: '0.875rem',
            fontWeight: 'medium',
            cursor: canCreate ? 'pointer' : 'not-allowed',
          })}
        >
          {t('group.create')}
        </button>
      </div>
    </Modal>
  )
}

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
