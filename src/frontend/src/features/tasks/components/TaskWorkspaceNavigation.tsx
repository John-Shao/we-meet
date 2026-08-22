import { useTranslation } from 'react-i18next'

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
              <span>{t(`workspace.views.${view}`)}</span>
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
  width: '224px',
  flexShrink: 0,
  flexDirection: 'column',
  gap: '1rem',
  padding: '1rem 0.75rem',
  borderRight: '1px solid token(colors.greyscale.200)',
  backgroundColor: 'greyscale.50',
})
const navTitleCss = css({
  margin: 0,
  paddingX: '0.75rem',
  color: 'default.text',
  fontSize: '1.25rem',
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
  padding: '0.75rem',
  backgroundColor: 'transparent',
  color: 'default.text',
  cursor: 'pointer',
  textAlign: 'left',
  '&[data-active]': {
    backgroundColor: 'primary.50',
    color: 'primary.700',
    fontWeight: '600',
  },
  _hover: { backgroundColor: 'greyscale.100' },
})
const mobileNavCss = css({
  display: { base: 'block', md: 'none' },
  padding: '0.75rem 1rem 0',
})
