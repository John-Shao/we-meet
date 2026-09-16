import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Redirect, useLocation, useSearch } from 'wouter'
import {
  RiMicLine,
  RiUpload2Line,
  RiVidiconLine,
  RiFileTextLine,
  RiFilter3Line,
  RiLayoutGridLine,
  RiListUnordered,
} from '@remixicon/react'
import { openGlobalSearch } from '@/layout/globalSearchBus'
import { useConfig } from '@/api/useConfig'
import { useUser } from '@/features/auth'
import {
  Button,
  IconToggleButton,
  SegmentedControl,
  SearchBox,
} from '@/primitives'
import { selectChrome } from '@/primitives/selectChrome'
import { PageState } from '@/components/PageState'
import { StateHint } from '@/components/StateHint'
import { css, cx } from '@/styled-system/css'
import { useMeetingRecords } from '../api/fetchMeetingRecord'
import {
  cardTitle,
  groupLabel,
  pageHeaderRow,
  pageHeaderText,
  pageLead,
  pageTitle,
  rowMeta,
} from '../components/libraryStyles'
import { MeetingModuleNav } from '../components/MeetingModuleNav'
import { MeetingModuleShell } from '../components/MeetingModuleShell'
import { RecordingUpload } from '../components/RecordingUpload'
import type { MeetingRecordFilters } from '../api/ApiMeetingRecord'

/** 工具行:范围筛选在左,紧凑图标动作在右。 */
const toolbar = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'sm',
  marginBottom: 'lg',
})

/**
 * 页壳。占满内容列的高度并自己管滚动,**不再设 maxWidth / margin auto** ——
 * 之前版心锁在 1120px 居中,窗口一宽两边就各留一大块空白。
 * 结构与任务列表一致:页壳 flex 列 + 固定区(flexShrink 0)+ 滚动区(flex 1)。
 */
const pageShell = css({
  flex: '1 1 0',
  minHeight: 0,
  width: '100%',
  display: 'flex',
  flexDirection: 'column',
  backgroundColor: 'surface.canvas',
  '&[data-minutes=true]': { backgroundColor: 'surface.default' },
})

/** 列表以上部分:固定,不随列表滚动。底边分隔线(R=border.subtle=greyscale.200)。 */
const pageFixedTop = css({
  flexShrink: 0,
  paddingX: 'lg',
  paddingTop: 'xl',
  borderBottom: '1px solid token(colors.border.subtle)',
})

/** 唯一的滚动区。内边距留在里面,最后一行才不会贴着底。 */
const listRegion = css({
  flex: 1,
  minHeight: 0,
  overflow: 'auto',
  paddingX: 'lg',
  paddingTop: 'xs',
  paddingBottom: '2xl',
})

/** 窄屏会横滚,不能被 flex 压扁。 */
const toolbarScroll = css({
  display: 'flex',
  flex: 1,
  minWidth: 0,
  overflowX: 'auto',
})

/** 搜索行:输入 + 提交。整行钉 14px,两个控件才落在同一档 32px 高度上。 */
const searchRow = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'md',
  alignItems: 'center',
  marginBottom: 'lg',
  textStyle: 'bodyMedium',
})

const searchBoxCls = css({ flex: '1 1 14rem', minWidth: 0 })

/** 搜索词输入上限(沿用收口前那个 `<input maxLength={200}>`)。 */
const SEARCH_MAX_LENGTH = 200

/** 展开的筛选面板。 */
const filterPanel = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'lg',
  flexBasis: '100%',
  padding: 'lg',
  borderRadius: 'card',
  backgroundColor: 'surface.default',
  border: '1px solid token(colors.border.subtle)',
})

const filterLabel = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'sm',
  textStyle: 'labelLarge',
  color: 'text.secondary',
})

/** 原生 select 走共享 chrome:自绘箭头、32px 钉高、option 跟随主题。 */
const filterSelect = cx(selectChrome, css({ minWidth: '9rem' }))

/** 一条记录(卡 / 行)的外壳。 */
const cardShell = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'lg',
  height: '100%',
  padding: 'lg',
  borderRadius: 'card',
  backgroundColor: 'surface.default',
  border: '1px solid token(colors.border.subtle)',
  textDecoration: 'none',
  color: 'text.primary',
  cursor: 'pointer',
  transition:
    'border-color token(durations.fast), box-shadow token(durations.fast), background-color token(durations.fast)',
  _hover: { borderColor: 'border.strong', boxShadow: 'raised' },
  _focusVisible: {
    outline: '2px solid token(colors.border.focus)',
    outlineOffset: '2px',
  },
  // 纪要页是「阅读器」的列表形态:不着卡,悬停只给一层浅底。
  '&[data-minutes=true]': {
    borderColor: 'transparent',
    paddingX: 'md',
    _hover: { backgroundColor: 'surface.canvas', boxShadow: 'none' },
  },
})

/** 卡片首字图标块:品牌浅蓝底 + 蓝图标(brand.* 随主题翻转)。 */
const cardIcon = css({
  flexShrink: 0,
  display: 'grid',
  placeItems: 'center',
  width: '3xl',
  height: '3xl',
  borderRadius: 'control',
  backgroundColor: 'brand.50',
  color: 'brand.600',
})

const cardBody = css({ minWidth: 0, flex: 1 })

const cardTitleCls = css({ lineClamp: 2 })

/** 来源 / 时间那一行:辅助信息 + 自带一档上边距。 */
const cardMeta = cx(
  rowMeta,
  css({
    marginTop: 'sm',
    display: 'flex',
    flexWrap: 'wrap',
    gap: 'sm',
  })
)

/** 「进行中 / 已有纪要」状态标签:蓝色前景,文字本身是第二重非颜色线索。 */
const statusTag = css({
  display: 'inline-flex',
  gap: 'sm',
  marginTop: 'sm',
  textStyle: 'labelMedium',
  color: 'text.link',
})

const listGrid = css({
  display: 'grid',
  gap: 'md',
  gridTemplateColumns: '1fr',
  '&[data-grid=true]': {
    md: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
  },
})

/** 分组标题自带间距(基类只给字号与颜色)。 */
const sectionHeading = cx(
  groupLabel,
  css({ marginTop: 'xl', marginBottom: 'md' })
)

/** 翻页行。 */
const pagerRow = css({
  display: 'flex',
  gap: 'md',
  alignItems: 'center',
  marginTop: 'lg',
})

/** 页头右侧动作组:窄屏换行,右对齐。 */
const headerActions = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 'md',
})

/** 栅格视图开关:窄屏隐藏。display 放外层,避免与基元 recipe 抢同一个原子类。 */
const gridToggleWrap = css({ display: { base: 'none', md: 'inline-flex' } })

/** 功能不可用时的兜底版心。 */
const unavailableLayout = css({
  maxWidth: '960px',
  width: '100%',
  margin: '0 auto',
  padding: 'xl',
})

/** 兜底页的「回会议首页」入口。 */
const homeLink = css({
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 'controlHeight.compact',
  paddingX: 'lg',
  borderRadius: 'control',
  textStyle: 'labelLarge',
  textDecoration: 'none',
  color: 'action.selected.text',
  backgroundColor: 'action.selected.bg',
  _focusVisible: {
    outline: '2px solid token(colors.border.focus)',
    outlineOffset: '2px',
  },
})

/** Paged sections keep bounded private content and never merge another filter's cache. */
function RecordList({
  viewerId,
  filters,
  ongoing,
  grid,
  minutes = false,
}: {
  viewerId: string
  filters: MeetingRecordFilters
  ongoing: boolean
  grid: boolean
  minutes?: boolean
}) {
  const { t } = useTranslation('meetings')
  const [cursors, setCursors] = useState<string[]>([''])
  const query = useMeetingRecords(viewerId, true, {
    ...filters,
    is_ongoing: minutes ? undefined : ongoing ? 'true' : 'false',
    cursor: cursors.at(-1),
  })
  const sectionLabel = t(
    minutes
      ? 'minutesLibrary.all'
      : ongoing
        ? 'library.ongoing'
        : 'library.archive'
  )
  if (query.isError)
    return (
      <section aria-label={sectionLabel}>
        <h2 className={sectionHeading}>{sectionLabel}</h2>
        <StateHint
          state="error"
          action={
            <Button
              variant="tertiary"
              size="sm"
              onPress={() => void query.refetch()}
            >
              {t('library.refresh')}
            </Button>
          }
        >
          {t('library.loadError')}
        </StateHint>
      </section>
    )
  if (!query.data)
    return (
      <section aria-label={sectionLabel}>
        <h2 className={sectionHeading}>{sectionLabel}</h2>
        <StateHint state="loading">{t('loading')}</StateHint>
      </section>
    )
  if (ongoing && !query.data.results.length) return null
  return (
    <section aria-label={sectionLabel}>
      <h2 className={sectionHeading}>{sectionLabel}</h2>
      {!query.data.results.length && (
        <PageState
          density="compact"
          surface="card"
          icon={<RiFileTextLine size={20} />}
          title={t(minutes ? 'minutesLibrary.empty' : 'library.empty')}
          description={t(
            minutes ? 'minutesLibrary.emptyHint' : 'library.emptyHint'
          )}
        />
      )}
      <ul className={listGrid} data-grid={grid}>
        {query.data.results.map((record) => (
          <li key={record.id}>
            <Link
              href={`/meeting/records/${record.id}${minutes ? '?tab=summary' : ''}`}
              data-minutes={minutes}
              aria-label={record.title || t('library.untitled')}
              className={cardShell}
            >
              <span aria-hidden className={cardIcon}>
                {minutes ? (
                  <RiFileTextLine size={24} />
                ) : record.source_type === 'meeting' ? (
                  <RiVidiconLine size={24} />
                ) : record.source_type === 'upload' ? (
                  <RiUpload2Line size={24} />
                ) : (
                  <RiMicLine size={24} />
                )}
              </span>
              <div className={cardBody}>
                <h3 className={cx(cardTitle, cardTitleCls)}>
                  {record.title || t('library.untitled')}
                </h3>
                <p className={cardMeta}>
                  <time dateTime={record.origin_at}>
                    {minutes && `${t('minutesLibrary.recordedAt')} `}
                    {new Date(record.origin_at).toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                      ...(new Date(record.origin_at).getFullYear() !==
                      new Date().getFullYear()
                        ? { year: 'numeric' }
                        : {}),
                    })}
                  </time>
                  <span aria-hidden>·</span>
                  <span>{t(`library.source.${record.source_type}`)}</span>
                </p>
                {!minutes && (ongoing || record.has_summary) && (
                  <p className={statusTag}>
                    {ongoing && <span>{t('library.ongoing')}</span>}
                    {record.has_summary && (
                      <span>{t('library.minutesReady')}</span>
                    )}
                  </p>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>
      <div className={pagerRow}>
        {cursors.length > 1 && (
          <Button
            variant="secondary"
            size="action"
            onPress={() => setCursors((values) => values.slice(0, -1))}
          >
            {t('library.previous')}
          </Button>
        )}
        {query.data.next_cursor && (
          <Button
            variant="secondary"
            size="action"
            onPress={() =>
              setCursors((values) => [...values, query.data!.next_cursor!])
            }
          >
            {t('library.next')}
          </Button>
        )}
      </div>
    </section>
  )
}

export function Library({
  viewerId,
  minutes = false,
}: {
  viewerId: string
  minutes?: boolean
}) {
  const { t } = useTranslation('meetings')
  const { data: config } = useConfig()
  const [, navigate] = useLocation()
  const [scope, setScope] = useState<MeetingRecordFilters['scope']>(
    minutes ? 'owned' : 'recent'
  )
  const routeSearch = useSearch()
  const candidate = new URLSearchParams(routeSearch).get('source_type')
  const source: NonNullable<MeetingRecordFilters['source_type']> | '' =
    candidate === 'meeting' ||
    candidate === 'audio_recording' ||
    candidate === 'upload' ||
    candidate === 'recordings'
      ? candidate
      : ''
  const setSource = (
    value: NonNullable<MeetingRecordFilters['source_type']> | ''
  ) => {
    const params = new URLSearchParams(routeSearch)
    if (value) params.set('source_type', value)
    else params.delete('source_type')
    navigate(
      `${minutes ? '/meeting/minutes' : '/meeting/notes'}${params.size ? '?' + params : ''}`
    )
  }
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [showFilters, setShowFilters] = useState(!!source)
  const [grid, setGrid] = useState(false)
  const filters: MeetingRecordFilters = {
    scope,
    source_type: source || undefined,
    q: query,
    ...(minutes ? { has_summary: 'true' } : {}),
  }
  const filterKey = JSON.stringify([viewerId, filters])
  const scopeValues = minutes
    ? (['owned', 'participated', 'shared'] as const)
    : (['recent', 'owned', 'shared'] as const)
  return (
    <MeetingModuleShell compactNavigation>
      <main data-minutes={minutes} className={pageShell}>
        {/* 列表以上的一切(窄屏栏目行、页头、范围筛选、搜索/筛选)固定不滚 —— 与
            任务列表(TasksRoute 的 header + modeTabs + listRegion)同一套布局:
            页壳占满高度,只有列表区自己滚,滚到底也看得见当前筛选条件。 */}
        <div className={pageFixedTop}>
          <div className={css({ md: { display: 'none' } })}>
            <MeetingModuleNav
              current={minutes ? '/meeting/minutes' : '/meeting/notes'}
            />
          </div>
          <header className={pageHeaderRow}>
            <div className={pageHeaderText}>
              <h1 className={pageTitle}>
                {t(minutes ? 'library.minutes' : 'library.notes')}
              </h1>
              <p className={pageLead}>
                {t(minutes ? 'library.minutesHint' : 'library.notesHint')}
              </p>
            </div>
            <div className={headerActions}>
              {config?.search_ai?.enabled !== false && (
                <Button
                  variant="secondary"
                  size="action"
                  onPress={() => openGlobalSearch('ai', 'meetings')}
                >
                  {t('minutesReader.searchMeetings')}
                </Button>
              )}
              {!minutes && (
                <>
                  <RecordingUpload viewerId={viewerId} />
                  {config?.meeting_records?.capture_audio_enabled && (
                    <Button
                      size="action"
                      icon={<RiMicLine size={18} aria-hidden />}
                      onPress={() => navigate('/meeting/recording/capture')}
                    >
                      {t('library.startRecording')}
                    </Button>
                  )}
                </>
              )}
            </div>
          </header>
          {/* 范围筛选走共享分段控件:实录用 pill(紧凑筛选),纪要阅读器用
            underline(同级阅读模式)。焦点态、方向键与 Home / End 由基元提供。 */}
          <div className={toolbar}>
            <div className={toolbarScroll}>
              <SegmentedControl
                value={scope as string}
                items={scopeValues.map((value) => ({
                  id: value,
                  label: t(
                    `${minutes ? 'minutesLibrary.scope' : 'library.scope'}.${value}`
                  ),
                }))}
                onChange={(value) =>
                  setScope(value as MeetingRecordFilters['scope'])
                }
                ariaLabel={t('library.scopeLabel')}
                appearance={minutes ? 'underline' : 'pill'}
                density="compact"
              />
            </div>
            <IconToggleButton
              size="icon32"
              label={t('library.filters')}
              isSelected={showFilters || Boolean(source)}
              onPress={() => setShowFilters(!showFilters)}
            >
              <RiFilter3Line size={20} aria-hidden />
            </IconToggleButton>
            <div className={gridToggleWrap}>
              <IconToggleButton
                size="icon32"
                label={t(grid ? 'library.listView' : 'library.gridView')}
                isSelected={grid}
                onPress={() => setGrid(!grid)}
                data-desktop-only
              >
                {grid ? (
                  <RiListUnordered size={20} aria-hidden />
                ) : (
                  <RiLayoutGridLine size={20} aria-hidden />
                )}
              </IconToggleButton>
            </div>
          </div>
          <form
            className={searchRow}
            onSubmit={(event) => {
              event.preventDefault()
              setQuery(search.trim())
            }}
          >
            <SearchBox
              className={searchBoxCls}
              value={search}
              onChange={(value) => {
                // SearchBox 不带 maxLength,受控值在这里截断,行为与收口前的
                // `<input maxLength={200}>` 一致(粘贴超长文本同样被截到 200)。
                const next = value.slice(0, SEARCH_MAX_LENGTH)
                setSearch(next)
                if (!next) setQuery('')
              }}
              placeholder={t('library.search')}
              ariaLabel={t('library.search')}
            />
            <Button type="submit" variant="secondary" size="action">
              {t('library.searchButton')}
            </Button>
            {showFilters && (
              <div className={filterPanel}>
                <label className={filterLabel}>
                  {t('library.scopeLabel')}
                  <select
                    className={filterSelect}
                    value={scope}
                    onChange={(event) =>
                      setScope(
                        event.target.value as MeetingRecordFilters['scope']
                      )
                    }
                  >
                    {(['recent', 'owned', 'participated', 'shared'] as const)
                      .filter((value) => !minutes || value !== 'recent')
                      .map((value) => (
                        <option key={value} value={value}>
                          {t(
                            `${minutes ? 'minutesLibrary.scope' : 'library.scope'}.${value}`
                          )}
                        </option>
                      ))}
                  </select>
                </label>
                <label className={filterLabel}>
                  {t('library.sourceLabel')}
                  <select
                    className={filterSelect}
                    value={source}
                    onChange={(event) =>
                      setSource(
                        event.target.value as
                          | NonNullable<MeetingRecordFilters['source_type']>
                          | ''
                      )
                    }
                  >
                    <option value="">{t('library.allSources')}</option>
                    {(
                      [
                        'meeting',
                        'recordings',
                        'audio_recording',
                        'upload',
                      ] as const
                    ).map((value) => (
                      <option key={value} value={value}>
                        {t(`library.source.${value}`)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </form>
        </div>
        <div className={listRegion} data-testid="meeting-list-region">
          {!minutes && (
            <RecordList
              key={`${filterKey}:ongoing`}
              viewerId={viewerId}
              filters={filters}
              ongoing
              grid={grid}
            />
          )}
          <RecordList
            key={`${filterKey}:archive`}
            viewerId={viewerId}
            filters={filters}
            ongoing={false}
            grid={grid}
            minutes={minutes}
          />
        </div>
      </main>
    </MeetingModuleShell>
  )
}

function LibraryRoute({ minutes = false }: { minutes?: boolean }) {
  const { user, isLoggedIn } = useUser()
  const { data, isError } = useConfig()
  const { t } = useTranslation('meetings')
  if (isLoggedIn === false) return <Redirect to="/" />
  if (!user || (!data && !isError))
    return <StateHint state="loading">{t('loading')}</StateHint>
  if (isError || !data?.meeting_records?.enabled)
    return (
      <MeetingModuleShell>
        <main className={unavailableLayout}>
          <StateHint
            state="empty"
            action={
              <Link href="/meeting" className={homeLink}>
                {t('library.home')}
              </Link>
            }
          >
            {t('library.unavailable')}
          </StateHint>
        </main>
      </MeetingModuleShell>
    )
  return (
    <Library
      key={`${user.id}:${minutes}`}
      viewerId={user.id}
      minutes={minutes}
    />
  )
}

export function MeetingNotes() {
  return <LibraryRoute />
}
export function MeetingMinutes() {
  return <LibraryRoute minutes />
}
