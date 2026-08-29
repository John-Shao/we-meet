import { useTranslation } from 'react-i18next'
import {
  RiArrowDownLine,
  RiArrowUpLine,
  RiDeleteBinLine,
  RiEditLine,
  RiPushpinLine,
  RiStarLine,
  RiUnpinLine,
} from '@remixicon/react'

import { Button } from '@/primitives'
import { css } from '@/styled-system/css'

import type { ApiTaskSavedView } from '../api/ApiTask'

export const TaskSavedViewManager = ({
  views,
  onOpen,
  onRename,
  onDelete,
  onTogglePinned,
  onSetDefault,
  onMove,
}: {
  views: ApiTaskSavedView[]
  onOpen: (view: ApiTaskSavedView) => void
  onRename: (view: ApiTaskSavedView) => void
  onDelete: (view: ApiTaskSavedView) => void
  onTogglePinned: (view: ApiTaskSavedView) => void
  onSetDefault: (view: ApiTaskSavedView) => void
  onMove: (view: ApiTaskSavedView, direction: -1 | 1) => void
}) => {
  const { t } = useTranslation('tasks')
  const ordered = [...views].sort(
    (first, second) => first.position - second.position
  )

  if (ordered.length === 0) {
    return <p className={emptyCss}>{t('savedViews.empty')}</p>
  }

  return (
    <div className={listCss}>
      {ordered.map((view, index) => (
        <div key={view.id} className={rowCss}>
          <button type="button" onClick={() => onOpen(view)}>
            <span>{view.name}</span>
            <small>
              {view.is_default ? t('savedViews.default') : ''}
              {view.is_default && view.is_pinned ? ' · ' : ''}
              {view.is_pinned ? t('savedViews.pinned') : ''}
            </small>
          </button>
          <div className={actionsCss}>
            <Button
              variant="tertiary"
              size="icon24"
              aria-label={t('savedViews.moveUpNamed', { name: view.name })}
              isDisabled={index === 0}
              onPress={() => onMove(view, -1)}
            >
              <RiArrowUpLine size={16} />
            </Button>
            <Button
              variant="tertiary"
              size="icon24"
              aria-label={t('savedViews.moveDownNamed', { name: view.name })}
              isDisabled={index === ordered.length - 1}
              onPress={() => onMove(view, 1)}
            >
              <RiArrowDownLine size={16} />
            </Button>
            <Button
              variant="tertiary"
              size="icon24"
              aria-label={t('savedViews.renameNamed', { name: view.name })}
              onPress={() => onRename(view)}
            >
              <RiEditLine size={16} />
            </Button>
            <Button
              variant="tertiary"
              size="icon24"
              aria-label={t(
                view.is_pinned
                  ? 'savedViews.unpinNamed'
                  : 'savedViews.pinNamed',
                { name: view.name }
              )}
              onPress={() => onTogglePinned(view)}
            >
              {view.is_pinned ? (
                <RiUnpinLine size={16} />
              ) : (
                <RiPushpinLine size={16} />
              )}
            </Button>
            <Button
              variant="tertiary"
              size="icon24"
              aria-label={t('savedViews.defaultNamed', { name: view.name })}
              isDisabled={view.is_default}
              onPress={() => onSetDefault(view)}
            >
              <RiStarLine size={16} />
            </Button>
            <Button
              variant="tertiary"
              size="icon24"
              aria-label={t('savedViews.deleteNamed', { name: view.name })}
              onPress={() => onDelete(view)}
            >
              <RiDeleteBinLine size={16} />
            </Button>
          </div>
        </div>
      ))}
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
  '& > button': {
    minWidth: 0,
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    border: 0,
    background: 'transparent',
    color: 'default.text',
    cursor: 'pointer',
    textAlign: 'left',
    '& span': { fontSize: '0.875rem', fontWeight: '500' },
    '& small': { minHeight: '1rem', color: 'default.subtle-text' },
  },
})
const actionsCss = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.125rem',
})
const emptyCss = css({
  margin: 0,
  padding: '2rem',
  color: 'default.subtle-text',
  textAlign: 'center',
})
