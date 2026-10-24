import { useRef, useState } from 'react'
import { Link, useSearchParams } from 'wouter'
import { useTranslation } from 'react-i18next'
import {
  RiAddLine,
  RiArrowLeftLine,
  RiArrowUpLine,
  RiArrowDownLine,
  RiDraggable,
  RiSettings3Line,
} from '@remixicon/react'
import { useUser } from '@/features/auth'
import { RequireAuth } from '@/components/RequireAuth'
import { Screen } from '@/layout/Screen'
import { Button } from '@/primitives/Button'
import { css } from '@/styled-system/css'
import { appCatalog, type AppEntry, type AppId } from './catalog'
import { useAppPreferences } from './useAppPreferences'

const grid = css({
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(112px, 1fr))',
  gap: 'lg',
  paddingY: 'lg',
})
const tile = css({
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 'sm',
  padding: 'md',
  minHeight: '112px',
  border: 'none',
  borderRadius: 'card',
  background: 'transparent',
  color: 'text.primary',
  textDecoration: 'none',
  textAlign: 'center',
  textStyle: 'bodyMedium',
  cursor: 'pointer',
  _hover: { background: 'surface.canvas' },
  _focusVisible: { outline: '2px solid token(colors.border.focus)' },
})
const row = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 'md',
  paddingY: 'md',
  borderBottom: '1px solid token(colors.border.subtle)',
  minWidth: 0,
})
const sectionTitle = css({
  textStyle: 'titleMedium',
  color: 'text.primary',
  margin: 0,
})
const muted = css({ textStyle: 'bodyMedium', color: 'text.secondary' })
export function AppIcon({ app }: { app: AppEntry }) {
  return (
    <span
      className={css({
        display: 'inline-flex',
        flexShrink: 0,
        alignItems: 'center',
        justifyContent: 'center',
        width: '48px',
        height: '48px',
        borderRadius: 'card',
        background: 'action.selected.bg',
        color: 'action.selected.text',
      })}
    >
      <app.Icon size={26} aria-hidden="true" />
    </span>
  )
}

export function AppsContent({ ownerId }: { ownerId: string }) {
  const { t } = useTranslation('apps')
  const [params, setParams] = useSearchParams()
  const mode = params.get('view')
  const adding = mode === 'add' || mode === 'manage'
  const managing = mode === 'manage'
  const [category, setCategory] = useState('all')
  const [query, setQuery] = useState('')
  const [dragging, setDragging] = useState<AppId | null>(null)
  const dragId = useRef<AppId | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const preferences = useAppPreferences(ownerId)
  const apps = appCatalog
  const resolve = (ids: AppId[]) =>
    ids.flatMap((id) => {
      const app = apps.find((item) => item.id === id)
      return app ? [app] : []
    })
  const favorites = resolve(preferences.favorites)
  const visible = (
    managing
      ? favorites
      : category === 'recent'
        ? resolve(preferences.recent)
        : apps.filter((app) => category === 'all' || app.group === category)
  ).filter(
    (app) =>
      managing ||
      `${t(`items.${app.id}.name`)} ${t(`items.${app.id}.description`)}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase())
  )
  const navigate = (view: string | null) => {
    setQuery('')
    setCategory('all')
    setParams(view ? { view } : {})
  }
  const reorder = (id: AppId, target: AppId) => {
    preferences.move(id, target)
    setAnnouncement(t('orderSaved'))
  }
  const categories = ['all', 'recent', 'time', 'organization']
  const appTile = (app: AppEntry, section: string) => (
    <Link
      key={app.id}
      href={app.href}
      className={tile}
      data-testid={`${section}-${app.id}`}
      onClick={() => preferences.opened(app.id)}
    >
      <AppIcon app={app} />
      <span>{t(`items.${app.id}.name`)}</span>
    </Link>
  )

  return (
    <section
      aria-label={t('title')}
      className={css({
        height: '100%',
        minHeight: 0,
        flex: '1 1 0',
        display: 'flex',
        flexDirection: 'column',
        background: 'surface.default',
        color: 'text.primary',
      })}
    >
      <header
        className={css({
          display: 'flex',
          alignItems: 'center',
          gap: 'sm',
          paddingX: 'lg',
          minHeight: '48px',
          flexShrink: 0,
          borderBottom: '1px solid token(colors.border.subtle)',
        })}
      >
        {adding && (
          <Button
            variant="secondaryText"
            aria-label={t('back')}
            onPress={() => navigate(managing ? 'add' : null)}
          >
            <RiArrowLeftLine size={20} />
          </Button>
        )}
        <h1 className={css({ textStyle: 'titleLarge', margin: 0, flex: 1 })}>
          {t(managing ? 'manage' : adding ? 'addFavorites' : 'title')}
        </h1>
        <Button
          variant="secondaryText"
          onPress={() => navigate(managing ? 'add' : 'manage')}
          aria-label={t(managing ? 'done' : 'manage')}
        >
          <RiSettings3Line size={18} />
          {t(managing ? 'done' : 'manage')}
        </Button>
      </header>
      <div
        className={css({
          overflowY: 'auto',
          minHeight: 0,
          padding: 'lg',
          paddingBottom: '2xl',
        })}
      >
        {!adding ? (
          <section aria-label={t('favorites')}>
            <h2 className={sectionTitle}>{t('favorites')}</h2>
            <div className={grid}>
              {favorites.map((app) => appTile(app, 'favorite'))}
              <button
                type="button"
                className={tile}
                onClick={() => navigate('add')}
              >
                <span
                  className={css({
                    display: 'grid',
                    placeItems: 'center',
                    width: '48px',
                    height: '48px',
                    borderRadius: 'card',
                    background: 'surface.canvas',
                    color: 'text.secondary',
                  })}
                >
                  <RiAddLine size={28} />
                </span>
                {t('addFavorites')}
              </button>
            </div>
          </section>
        ) : (
          <div className={row}>
            <span className={muted}>
              {t('addedCount', { count: favorites.length })}
            </span>
            <div
              className={css({
                display: 'flex',
                flex: 1,
                minWidth: 0,
                gap: 'sm',
                overflowX: 'auto',
              })}
            >
              {favorites.map((app) => (
                <span key={app.id} title={t(`items.${app.id}.name`)}>
                  <AppIcon app={app} />
                </span>
              ))}
            </div>
          </div>
        )}
        <section aria-label={t(managing ? 'manage' : 'allApps')}>
          <div
            className={css({
              display: 'flex',
              flexWrap: 'wrap',
              gap: 'md',
              justifyContent: 'space-between',
              alignItems: 'center',
              paddingY: 'lg',
            })}
          >
            <h2 className={sectionTitle}>
              {t(managing ? 'favorites' : 'allApps')}
            </h2>
            {!managing && (
              <input
                type="search"
                aria-label={t('search')}
                placeholder={t('search')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className={css({
                  border: '1px solid token(colors.border.default)',
                  borderRadius: 'field',
                  padding: 'sm',
                  background: 'surface.default',
                  color: 'text.primary',
                  width: 'min(100%, 280px)',
                })}
              />
            )}
          </div>
          {managing ? (
            <p className={muted}>{t('reorderHint')}</p>
          ) : (
            <div
              aria-label={t('categories')}
              className={css({
                display: 'flex',
                gap: 'sm',
                overflowX: 'auto',
                paddingBottom: 'sm',
                borderBottom: '1px solid token(colors.border.subtle)',
              })}
            >
              {categories.map((value) => (
                <Button
                  key={value}
                  variant={category === value ? 'primary' : 'secondaryText'}
                  aria-pressed={category === value}
                  onPress={() => setCategory(value)}
                >
                  {t(`groups.${value}`)}
                </Button>
              ))}
            </div>
          )}
          {visible.length === 0 && (
            <p
              role="status"
              className={css({
                paddingY: '2xl',
                color: 'text.secondary',
                textStyle: 'bodyMedium',
              })}
            >
              {t(
                managing
                  ? 'emptyFavorites'
                  : query.trim()
                    ? 'emptySearch'
                    : category === 'recent'
                      ? 'emptyRecent'
                      : 'emptyApps'
              )}
            </p>
          )}
          {!adding ? (
            <div className={grid}>
              {visible.map((app) => appTile(app, 'catalog'))}
            </div>
          ) : (
            <ul className={css({ listStyle: 'none', padding: 0, margin: 0 })}>
              {visible.map((app, index) => (
                <li
                  key={app.id}
                  data-app-id={app.id}
                  className={row}
                  style={{ opacity: dragging === app.id ? 0.5 : 1 }}
                  onDragOver={(event) => {
                    if (managing && dragId.current) {
                      event.preventDefault()
                      event.dataTransfer.dropEffect = 'move'
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    if (managing && dragId.current)
                      reorder(dragId.current, app.id)
                    dragId.current = null
                    setDragging(null)
                  }}
                >
                  <AppIcon app={app} />
                  <div
                    className={css({ flex: '1 1 100px', minWidth: '100px' })}
                  >
                    <h3 className={css({ textStyle: 'bodyLarge', margin: 0 })}>
                      {t(`items.${app.id}.name`)}
                    </h3>
                    {!managing && (
                      <p className={muted}>
                        {t(`items.${app.id}.description`)}
                      </p>
                    )}
                  </div>
                  {managing ? (
                    <div
                      className={css({
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 'xs',
                        alignItems: 'center',
                        justifyContent: 'flex-end',
                        width: '100%',
                        md: { width: 'auto' },
                      })}
                    >
                      <Button
                        variant="secondaryText"
                        size="icon32"
                        aria-label={t('moveUp', {
                          name: t(`items.${app.id}.name`),
                        })}
                        isDisabled={index === 0}
                        onPress={() => reorder(app.id, favorites[index - 1].id)}
                      >
                        <RiArrowUpLine size={16} />
                      </Button>
                      <Button
                        variant="secondaryText"
                        size="icon32"
                        aria-label={t('moveDown', {
                          name: t(`items.${app.id}.name`),
                        })}
                        isDisabled={index === favorites.length - 1}
                        onPress={() => reorder(app.id, favorites[index + 1].id)}
                      >
                        <RiArrowDownLine size={16} />
                      </Button>
                      <Button
                        variant="secondaryText"
                        size="dense"
                        onPress={() => preferences.remove(app.id)}
                        aria-label={t('removeName', {
                          name: t(`items.${app.id}.name`),
                        })}
                      >
                        {t('remove')}
                      </Button>
                      <button
                        type="button"
                        draggable
                        aria-label={t('dragName', {
                          name: t(`items.${app.id}.name`),
                        })}
                        className={css({
                          display: 'grid',
                          placeItems: 'center',
                          border: 'none',
                          background: 'transparent',
                          color: 'text.secondary',
                          cursor: 'grab',
                          padding: 'sm',
                        })}
                        onDragStart={(event) => {
                          dragId.current = app.id
                          setDragging(app.id)
                          event.dataTransfer.effectAllowed = 'move'
                          event.dataTransfer.setData('text/plain', app.id)
                        }}
                        onDragEnd={() => {
                          dragId.current = null
                          setDragging(null)
                        }}
                      >
                        <RiDraggable size={20} />
                      </button>
                    </div>
                  ) : (
                    <Button
                      variant="secondary"
                      isDisabled={preferences.favorites.includes(app.id)}
                      aria-label={t(
                        preferences.favorites.includes(app.id)
                          ? 'addedName'
                          : 'addName',
                        { name: t(`items.${app.id}.name`) }
                      )}
                      onPress={() => preferences.add(app.id)}
                    >
                      {t(
                        preferences.favorites.includes(app.id) ? 'added' : 'add'
                      )}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        <span role="status" className={css({ srOnly: true })}>
          {announcement}
        </span>
      </div>
    </section>
  )
}

export function AppsRoute() {
  const { user } = useUser()
  return (
    <RequireAuth>
      <Screen footer={false}>
        <AppsContent key={user?.id} ownerId={user?.id ?? ''} />
      </Screen>
    </RequireAuth>
  )
}
