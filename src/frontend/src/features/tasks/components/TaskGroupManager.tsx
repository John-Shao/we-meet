import { useTranslation } from 'react-i18next'
import {
  RiArrowDownLine,
  RiArrowUpLine,
  RiDeleteBinLine,
  RiEditLine,
} from '@remixicon/react'

import { Button } from '@/primitives'
import { css } from '@/styled-system/css'

import type { ApiTaskGroup } from '../api/ApiTask'

export const TaskGroupManager = ({
  groups,
  onCreate,
  onRename,
  onDelete,
  onMove,
}: {
  groups: ApiTaskGroup[]
  onCreate: () => void
  onRename: (group: ApiTaskGroup) => void
  onDelete: (group: ApiTaskGroup) => void
  onMove: (group: ApiTaskGroup, direction: -1 | 1) => void
}) => {
  const { t } = useTranslation('tasks')
  const ordered = [...groups].sort(
    (first, second) =>
      first.sort_order - second.sort_order ||
      first.created_at.localeCompare(second.created_at)
  )

  return (
    <div className={listCss}>
      <div className={createCss}>
        <Button size="action" onPress={onCreate}>
          {t('groups.create')}
        </Button>
      </div>
      {ordered.length === 0 ? (
        <p className={emptyCss}>{t('groups.emptyNavigation')}</p>
      ) : (
        ordered.map((group, index) => {
          const previous = ordered[index - 1]
          const next = ordered[index + 1]
          return (
            <div key={group.id} className={rowCss}>
              <div>
                <span>{group.name}</span>
                <small>
                  {t('groups.taskCount', { count: group.task_count })}
                </small>
              </div>
              <div className={actionsCss}>
                <Button
                  variant="tertiary"
                  size="icon24"
                  aria-label={t('groups.moveUpNamed', { name: group.name })}
                  isDisabled={!group.can_manage || !previous?.can_manage}
                  onPress={() => onMove(group, -1)}
                >
                  <RiArrowUpLine size={16} />
                </Button>
                <Button
                  variant="tertiary"
                  size="icon24"
                  aria-label={t('groups.moveDownNamed', { name: group.name })}
                  isDisabled={!group.can_manage || !next?.can_manage}
                  onPress={() => onMove(group, 1)}
                >
                  <RiArrowDownLine size={16} />
                </Button>
                <Button
                  variant="tertiary"
                  size="icon24"
                  aria-label={t('groups.renameNamed', { name: group.name })}
                  isDisabled={!group.can_manage}
                  onPress={() => onRename(group)}
                >
                  <RiEditLine size={16} />
                </Button>
                <Button
                  variant="tertiary"
                  size="icon24"
                  aria-label={t('groups.deleteNamed', { name: group.name })}
                  isDisabled={!group.can_manage || !group.can_delete}
                  onPress={() => onDelete(group)}
                >
                  <RiDeleteBinLine size={16} />
                </Button>
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}

const listCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  padding: '0.75rem',
  overflowY: 'auto',
})
const rowCss = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.75rem',
  padding: '0.5rem',
  borderRadius: '8px',
  backgroundColor: 'greyscale.100',
  '& > div:first-child': {
    minWidth: 0,
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    '& span': {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      fontSize: '0.875rem',
      fontWeight: '500',
    },
    '& small': { color: 'default.subtle-text' },
  },
})
const actionsCss = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.125rem',
})
const createCss = css({ display: 'flex', justifyContent: 'flex-end' })
const emptyCss = css({
  margin: 0,
  padding: '2rem',
  color: 'default.subtle-text',
  textAlign: 'center',
})
