import { useTranslation } from 'react-i18next'
import {
  RiCheckboxCircleLine,
  RiFileAddLine,
  RiListCheck3,
  RiUserLine,
} from '@remixicon/react'

import { Select } from '@/primitives/Select'
import { css } from '@/styled-system/css'

import type {
  TaskWorkspaceState,
  TaskWorkspaceView,
} from '../taskWorkspaceState'

const views: TaskWorkspaceView[] = ['assigned', 'created', 'all', 'completed']

const activeView = (state: TaskWorkspaceState): TaskWorkspaceView => {
  if (state.scope === 'all' && state.status === 'completed') return 'completed'
  return state.scope
}

export const TaskWorkspaceNavigation = ({
  state,
  count,
  onChange,
}: {
  state: TaskWorkspaceState
  count: number
  onChange: (view: TaskWorkspaceView) => void
}) => {
  const { t } = useTranslation('tasks')
  const current = activeView(state)
  return (
    <>
      <aside className={desktopNavCss} aria-label={t('workspace.navigation')}>
        <h1 className={navTitleCss}>{t('title')}</h1>
        <nav className={navListCss}>
          {views.map((view) => (
            <button
              key={view}
              type="button"
              aria-current={current === view ? 'page' : undefined}
              className={navButtonCss}
              data-active={current === view || undefined}
              onClick={() => onChange(view)}
            >
              <span className={navLabelCss}>
                {view === 'assigned' ? (
                  <RiUserLine size={18} />
                ) : view === 'created' ? (
                  <RiFileAddLine size={18} />
                ) : view === 'completed' ? (
                  <RiCheckboxCircleLine size={18} />
                ) : (
                  <RiListCheck3 size={18} />
                )}
                <span>{t(`workspace.views.${view}`)}</span>
              </span>
              {current === view && (
                <span aria-label={t('workspace.resultCount', { count })}>
                  {count}
                </span>
              )}
            </button>
          ))}
        </nav>
      </aside>
      <div className={mobileNavCss}>
        <Select
          label={t('workspace.mobileView')}
          aria-label={t('workspace.mobileView')}
          items={views.map((value) => ({
            value,
            label: t(`workspace.views.${value}`),
          }))}
          selectedKey={current}
          onSelectionChange={(key) =>
            onChange(String(key) as TaskWorkspaceView)
          }
        />
      </div>
    </>
  )
}

const desktopNavCss = css({
  display: { base: 'none', md: 'flex' },
  width: '100%',
  height: '100%',
  flexDirection: 'column',
  gap: '0.25rem',
  padding: '1rem 0.75rem',
  borderRight: '1px solid token(colors.greyscale.200)',
  backgroundColor: 'greyscale.000',
  overflowY: 'auto',
})
const navTitleCss = css({
  margin: '0 0 0.5rem',
  paddingX: '0.5rem',
  color: 'greyscale.900',
  fontSize: '1.125rem',
  fontWeight: 'bold',
})
const navListCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
})
const navButtonCss = css({
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.75rem',
  border: 0,
  borderRadius: '8px',
  paddingX: '0.625rem',
  paddingY: '0.5rem',
  backgroundColor: 'transparent',
  color: 'greyscale.700',
  cursor: 'pointer',
  textAlign: 'left',
  fontSize: '0.875rem',
  '&[data-active]': {
    backgroundColor: 'selected.bg',
    color: 'selected.text',
    fontWeight: '500',
  },
  _hover: { backgroundColor: 'greyscale.100' },
})
const navLabelCss = css({
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.625rem',
})
const mobileNavCss = css({
  display: { base: 'block', md: 'none' },
  padding: '0.75rem 1rem 0',
})
