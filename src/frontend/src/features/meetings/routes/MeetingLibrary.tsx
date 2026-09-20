import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Redirect, useLocation, useSearch } from 'wouter'
import {
  RiArrowDownSLine,
  RiArrowUpSLine,
  RiMicLine,
  RiUpload2Line,
  RiVidiconLine,
  RiFileTextLine,
  RiFilter3Line,
  RiLayoutGridLine,
  RiListUnordered,
  RiSparklingLine,
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
  contentSurface,
  groupLabel,
  headerActions,
  pageFixedTop,
  pageHeaderRow,
  pageHeaderText,
  pageShell,
  pageTitle,
  rowBody,
  rowHeadingClamped,
  rowIconTile,
  rowIconTileCompact,
  rowMeta,
  rowMetaRow,
  sectionHeading,
  scrollRegion,
} from '../components/libraryStyles'
import { RecordTrashLibrary } from '../components/RecordTrash'
import { MeetingModuleNav } from '../components/MeetingModuleNav'
import { MeetingModuleShell } from '../components/MeetingModuleShell'
import { recordSourceKey } from '../recordSource'
import { recordDateRange } from '../recordDateRange'
import type {
  MeetingRecordFilters,
  MeetingRecordSource,
} from '../api/ApiMeetingRecord'

/** 列表视图的排序方向(只有「创建时间」这一列可排)。 */
type SortDirection = 'asc' | 'desc'

/** 表格列数:表头与每个整行单元格的 colSpan 都取它,以后加列只改这一处。 */
const COLUMN_COUNT = 4

/** 工具行:范围筛选在左,紧凑图标动作在右。 */
const toolbar = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'sm',
  // 与标题栏之间的 16px 间距(标题行自己不再带下外边距,见 libraryStyles.pageHeaderRow)。
  marginTop: 'lg',
  marginBottom: 'lg',
})

/** 两种页壳:纪要是白底阅读面,实录用 canvas,卡片才立得起来。 */
const canvasShell = pageShell('canvas')

/** 列表区补一档顶部内边距(固定区已经有自己的下边距)。 */
/** 列表区:唯一的滚动区,内容铺白(一级页规则,见 libraryStyles.contentSurface)。 */
const listRegion = cx(scrollRegion, contentSurface, css({ paddingTop: 'xs' }))

/** 窄屏会横滚,不能被 flex 压扁。 */
const toolbarScroll = css({
  display: 'flex',
  flex: 1,
  minWidth: 0,
  overflowX: 'auto',
})

/**
 * 搜索框所在的表单(在页头动作行里)。只剩一个输入:提交靠回车 —— 原先那颗
 * 「搜索」按钮已去掉,所以这里不写按钮,`role="search"` 给读屏一个地标。
 */
const searchForm = css({ display: 'flex', alignItems: 'center', minWidth: 0 })

/**
 * 搜索框:宽屏钉 18rem(288px)—— 与「搜索会议 AI」并排后不再独占一行;28rem 会把
 * 标题块挤成两三行。窄屏放开收缩:390px 下这一行是「输入框 + 搜索会议 AI」,输入框
 * 让出空间 —— 不折行,也不横向溢出。
 */
const searchBoxCls = css({
  flex: { base: '0 1 18rem', md: '0 0 18rem' },
  minWidth: 0,
})

/** 搜索词输入上限(沿用收口前那个 `<input maxLength={200}>`)。 */
const SEARCH_MAX_LENGTH = 200

/** 展开的筛选面板(独立于搜索表单,落在工具栏下方)。 */
const filterPanel = css({
  display: 'flex',
  flexWrap: 'wrap',
  gap: 'lg',
  marginBottom: 'lg',
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
const dateInput = css({
  border: '1px solid token(colors.border.subtle)',
  borderRadius: 'control',
  padding: 'sm',
  color: 'text.primary',
  backgroundColor: 'surface.default',
  minWidth: 0,
})

/**
 * 一条记录(行)的外壳 —— 四个栏目页共用的**样板行**:不着卡、悬停一层浅底。
 * 「智能纪要」原先只是这一档的 `[data-minutes=true]` 变体,现在实录页也走同一套,
 * 两个页面只有内容与文案的差别,不再有「卡 / 无边框」两种列表形态。
 */
const cardShell = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'lg',
  height: '100%',
  padding: 'lg',
  paddingX: 'md',
  borderRadius: 'card',
  backgroundColor: 'transparent',
  borderColor: 'transparent',
  textDecoration: 'none',
  color: 'text.primary',
  cursor: 'pointer',
  transition: 'background-color token(durations.fast)',
  _hover: { backgroundColor: 'surface.canvas' },
  _focusVisible: {
    outline: '2px solid token(colors.border.focus)',
    outlineOffset: '2px',
  },
})

/** 卡片首字图标块、正文列与标题一律取共享样板(libraryStyles)。 */
const cardTitleCls = rowHeadingClamped

/** 来源 / 时间那一行:辅助信息 + 自带一档上边距(横排)。 */
const cardMeta = rowMetaRow

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

/**
 * 列表视图(表格)。对齐飞书的四列:**表头只在列表最上方出现一次**,分组名走表内的
 * 行组标题单元格(见 `groupRowCell`),所以两段列表共用一份列宽、列名不会各来一遍。
 *
 * `table-layout: fixed` 只在 md 起步用:窄屏收起后三列,列表退回「标题 + 一行辅助
 * 信息」,auto 布局下单一列自然铺满,不会有定宽列留下的空档。
 */
const tableCls = css({
  width: '100%',
  tableLayout: { base: 'auto', md: 'fixed' },
  borderCollapse: 'separate',
  borderSpacing: 0,
  '& thead th': {
    position: 'sticky',
    // 钉在滚动区顶部(列表区是这一页唯一的滚动容器),长列表里列名不丢。
    top: 0,
    zIndex: 2,
    paddingY: 'sm',
    paddingX: 'sm',
    textAlign: 'left',
    textStyle: 'labelMedium',
    color: 'text.secondary',
    whiteSpace: 'nowrap',
    backgroundColor: 'surface.default',
    borderBottom: '1px solid token(colors.border.subtle)',
  },
  '& td': {
    paddingY: 'xs',
    paddingX: 'sm',
    verticalAlign: 'middle',
    textStyle: 'bodySmall',
    color: 'text.secondary',
  },
  // 首列是行主单元格:左右内边距带在链接上 —— 整格可点,悬停底色左右都贴到行边缘。
  '& th:first-child, & td:first-child': { paddingX: 0 },
  // 只有数据行有悬停底色:分组行、翻页行、空态格都不是可点的记录。
  '& tbody tr[data-record-row]:hover': { backgroundColor: 'surface.canvas' },
})

/** 表头行整体在窄屏收起(那一屏只有标题一列,列名没有意义)。 */
const tableHead = css({ display: { base: 'none', md: 'table-header-group' } })

/**
 * 后三列:内容短、定宽,md 以下整列收起(信息并进行尾的辅助信息一行)。列宽写在
 * 单元格上:fixed 布局按**第一行**(也就是表头)定列宽;宽度各自独立成一条规则,
 * 不与上面的通用列样式抢同一个原子类(cx 叠同属性谁赢看样式表顺序)。
 */
const tableMetaCell = css({
  display: { base: 'none', md: 'table-cell' },
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})

/** 所有者列比时间列窄一档(名字通常比「9月13日 08:00」短)。 */
const ownerCell = css({ width: '16%' })

/** 两个时间列同宽,给「9月13日 08:00」留够位置。 */
const timeCell = css({ width: '18%' })

/** 可排序的表头:整格是按钮,箭头指向当前方向。 */
const sortButton = css({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'xxs',
  margin: 0,
  padding: 0,
  border: 'none',
  backgroundColor: 'transparent',
  color: 'inherit',
  textStyle: 'labelMedium',
  cursor: 'pointer',
  _hover: { color: 'text.primary' },
  _focusVisible: {
    outline: '2px solid token(colors.border.focus)',
    outlineOffset: '2px',
  },
})

/**
 * 行组标题单元格(「进行中」「历史记录」「全部智能纪要」)。
 *
 * 表格里不能再套 `<h2>`(td/th 不接受标题内容),所以这里用行组标题:`<th
 * scope="rowgroup">` 读屏会读成这一组的表头,视觉上与原来的小节标题同档。
 */
const groupRowCell = cx(
  groupLabel,
  css({
    paddingX: 0,
    paddingTop: 'xl',
    paddingBottom: 'sm',
    textAlign: 'left',
    backgroundColor: 'surface.default',
  })
)

/** 行链接:图标 + 正文两行塞在一个格子里,整格可点、焦点环贴住行。 */
const tableRowLink = css({
  display: 'flex',
  alignItems: 'center',
  gap: 'md',
  paddingY: 'xs',
  paddingX: 'sm',
  color: 'inherit',
  textDecoration: 'none',
  _focusVisible: {
    outline: '2px solid token(colors.border.focus)',
    outlineOffset: '-2px',
  },
})

/**
 * 表格行主标题:与卡片同档字号。
 *
 * 窄屏没有固定列宽可比,标题**允许换行** —— 单行省略(nowrap)的标题在这里会把
 * 表格的 min-content 撑到比容器还宽,列表区就出现横向滚动。md 起列宽定下来,
 * 才切成单行省略。
 */
const tableTitle = cx(
  cardTitle,
  css({
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'normal',
    md: { whiteSpace: 'nowrap' },
  })
)

/** 表格行副行:会议时间 · 来源 · 上传状态,窄屏再补一个所有者。 */
const tableMeta = cx(
  rowMeta,
  css({
    marginTop: 'xxs',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 'sm',
  })
)

/** 只在窄屏出现的片段(所有者那一列收起时,信息并进副行)。 */
const narrowOnly = css({
  display: { base: 'inline-flex', md: 'none' },
  alignItems: 'center',
  // 与副行同一个间距:里面的分隔点才不会贴住名字(「·UI Owner」)。
  gap: 'sm',
})

/** 行内状态徽标(「进行中」「已有纪要」):蓝色前景,文字本身是第二重非颜色线索。 */
const statusBadge = css({
  display: 'inline-flex',
  alignItems: 'center',
  textStyle: 'labelMedium',
  color: 'text.link',
})

/** 翻页行。 */
const pagerRow = css({
  display: 'flex',
  gap: 'md',
  alignItems: 'center',
  marginTop: 'lg',
})

/** 栅格视图开关:窄屏隐藏。display 放外层,避免与基元 recipe 抢同一个原子类。 */
const gridToggleWrap = css({ display: { base: 'none', md: 'inline-flex' } })

/**
 * 功能不可用时的兜底页。
 *
 * 原先这里自己写了一份 `maxWidth: 960px` + `margin: 0 auto` 的限宽居中版心 ——
 * 收口记录 §3.1 已把限宽版心整个删掉(「窗口一宽两侧就各留一大块空白」),
 * 这个分支是当时漏掉的一处。现在与四个栏目页共用 `pageShell('canvas')`:
 * 铺满内容列、高度占满,状态块在其中居中。
 *
 * 状态本身也从 `StateHint`(面板级)换成 `PageState`(页面主内容区),与
 * `docs/component-system.md` §「加载、空数据与错误状态」的分工一致。
 */
const unavailableLayout = cx(
  pageShell('canvas'),
  css({ padding: 'xl', justifyContent: 'center' })
)

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

/**
 * 表格里的时间:同年只到「月日 时:分」,跨年补年份。解析不出来返回 `null`(整格
 * 退成「—」),不回显服务端的原始脏值 —— 与预约 / 历史列表同一处理。
 */
const formatRecordTime = (iso?: string): string | null => {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString(undefined, {
    ...(date.getFullYear() !== new Date().getFullYear()
      ? { year: 'numeric' }
      : {}),
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** 行首图标:纪要一律文档,其余按来源(线上会议 / 上传文件 / 独立录音)。 */
const recordIcon = (
  source: MeetingRecordSource,
  minutes: boolean,
  size: number
) =>
  minutes ? (
    <RiFileTextLine size={size} />
  ) : source === 'meeting' ? (
    <RiVidiconLine size={size} />
  ) : source === 'upload' ? (
    <RiUpload2Line size={size} />
  ) : (
    <RiMicLine size={size} />
  )

/** Paged sections keep bounded private content and never merge another filter's cache. */
function RecordList({
  viewerId,
  filters,
  ongoing,
  grid,
  cursors,
  onCursors,
  minutes = false,
}: {
  viewerId: string
  filters: MeetingRecordFilters
  ongoing: boolean
  grid: boolean
  /** 这一节的游标栈:末尾是本页游标,栈长 > 1 就说明翻过页。 */
  cursors: string[]
  onCursors: (cursors: string[]) => void
  minutes?: boolean
}) {
  const { t } = useTranslation('meetings')
  const query = useMeetingRecords(viewerId, true, {
    ...filters,
    is_ongoing: minutes ? undefined : ongoing ? 'true' : 'false',
    cursor: cursors.at(-1),
  })
  // 权限被收回后 react-query 仍留着上一次的数据,错误态必须一行都不渲染。
  const records = query.isError ? [] : (query.data?.results ?? [])
  const sectionLabel = t(
    minutes
      ? 'minutesLibrary.all'
      : ongoing
        ? 'library.ongoing'
        : 'library.archive'
  )
  // 错误 / 加载两态在两种视图里各自落在一节 / 一行的位置,内容块先算出来。
  const stateHint = query.isError ? (
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
  ) : !query.data ? (
    <StateHint state="loading">{t('loading')}</StateHint>
  ) : null
  const emptyState = (
    <PageState
      density="compact"
      surface="card"
      icon={<RiFileTextLine size={20} />}
      title={t(minutes ? 'minutesLibrary.empty' : 'library.empty')}
      description={t(
        minutes ? 'minutesLibrary.emptyHint' : 'library.emptyHint'
      )}
    />
  )
  const isEmpty = Boolean(
    !query.isError && query.data && !query.data.results.length
  )
  // 进行中的分组没有内容时整组不出现(与卡片视图同一条规则)。
  if (ongoing && isEmpty) return null
  const pager = (
    <>
      {cursors.length > 1 && (
        <Button
          variant="secondary"
          size="action"
          onPress={() => onCursors(cursors.slice(0, -1))}
        >
          {t('library.previous')}
        </Button>
      )}
      {query.data?.next_cursor && (
        <Button
          variant="secondary"
          size="action"
          onPress={() => onCursors([...cursors, query.data!.next_cursor!])}
        >
          {t('library.next')}
        </Button>
      )}
    </>
  )
  if (grid)
    return (
      <section aria-label={sectionLabel}>
        <h2 className={sectionHeading}>{sectionLabel}</h2>
        {stateHint}
        {isEmpty && emptyState}
        <ul className={listGrid} data-grid={grid}>
          {records.map((record) => (
            <li key={record.id} data-record-row>
              <Link
                href={`/meeting/records/${record.id}${minutes ? '?tab=summary' : ''}`}
                aria-label={record.title || t('library.untitled')}
                className={cardShell}
              >
                <span aria-hidden className={rowIconTile}>
                  {recordIcon(record.source_type, minutes, 24)}
                </span>
                <div className={rowBody}>
                  {/* 长标题(上传文件的原始名可能很长)被省略时,悬停可看全。 */}
                  <h3
                    className={cx(cardTitle, cardTitleCls)}
                    title={record.title}
                  >
                    {record.title || t('library.untitled')}
                  </h3>
                  <p className={cardMeta}>
                    <time dateTime={record.origin_at}>
                      {minutes && `${t('minutesLibrary.recordedAt')} `}
                      {formatRecordTime(record.origin_at)}
                    </time>
                    <span aria-hidden>·</span>
                    <span>{t(recordSourceKey(record))}</span>
                    {/* 上传的处理状态在两个列表页都要看得见 —— 否则「上传中/失败」
                        只能在 AI 录音页看到,而这一页才是管理记录的入口。 */}
                    {record.upload &&
                      ` · ${t(`upload.status.${record.upload.status}`)}`}
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
        <div className={pagerRow}>{pager}</div>
      </section>
    )
  return (
    <tbody>
      <tr>
        <th scope="rowgroup" colSpan={COLUMN_COUNT} className={groupRowCell}>
          {sectionLabel}
        </th>
      </tr>
      {stateHint && (
        <tr>
          <td colSpan={COLUMN_COUNT}>{stateHint}</td>
        </tr>
      )}
      {isEmpty && (
        <tr>
          <td colSpan={COLUMN_COUNT}>{emptyState}</td>
        </tr>
      )}
      {records.map((record) => (
        <tr key={record.id} data-record-row>
          <td>
            <Link
              href={`/meeting/records/${record.id}${minutes ? '?tab=summary' : ''}`}
              aria-label={record.title || t('library.untitled')}
              className={tableRowLink}
            >
              <span aria-hidden className={rowIconTileCompact}>
                {recordIcon(record.source_type, minutes, 18)}
              </span>
              <span className={rowBody}>
                {/* 长标题(上传文件的原始名可能很长)被省略时,悬停可看全。 */}
                <span className={tableTitle} title={record.title}>
                  {record.title || t('library.untitled')}
                </span>
                <span className={tableMeta}>
                  <time dateTime={record.origin_at}>
                    {minutes && `${t('minutesLibrary.recordedAt')} `}
                    {formatRecordTime(record.origin_at)}
                  </time>
                  <span aria-hidden>·</span>
                  <span>{t(recordSourceKey(record))}</span>
                  {/* 所有者那一列在窄屏收起,这一份信息跟着并进副行。 */}
                  <span className={narrowOnly}>
                    <span aria-hidden>·</span>
                    {record.owner || t('library.ownerUnknown')}
                  </span>
                  {/* 上传的处理状态在两个列表页都要看得见 —— 否则「上传中/失败」
                      只能在 AI 录音页看到,而这一页才是管理记录的入口。 */}
                  {record.upload && (
                    <span>{t(`upload.status.${record.upload.status}`)}</span>
                  )}
                  {!minutes && ongoing && (
                    <span className={statusBadge}>{t('library.ongoing')}</span>
                  )}
                  {!minutes && record.has_summary && (
                    <span className={statusBadge}>
                      {t('library.minutesReady')}
                    </span>
                  )}
                </span>
              </span>
            </Link>
          </td>
          <td
            className={cx(tableMetaCell, ownerCell)}
            title={record.owner ?? undefined}
          >
            {record.owner || t('library.ownerUnknown')}
          </td>
          <td className={cx(tableMetaCell, timeCell)}>
            {formatRecordTime(record.updated_at) ?? '—'}
          </td>
          <td className={cx(tableMetaCell, timeCell)}>
            {formatRecordTime(record.created_at) ?? '—'}
          </td>
        </tr>
      ))}
      {(cursors.length > 1 || query.data?.next_cursor) && (
        <tr>
          <td colSpan={COLUMN_COUNT}>
            <div className={pagerRow}>{pager}</div>
          </td>
        </tr>
      )}
    </tbody>
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
  const [sort, setSort] = useState<SortDirection>('desc')
  const [dateDraft, setDateDraft] = useState({ from: '', through: '' })
  const [dates, setDates] = useState<{
    created_from?: string
    created_before?: string
  }>({})
  const [dateError, setDateError] = useState(false)
  const [dateLabels, setDateLabels] = useState({ from: '', through: '' })
  const filters: MeetingRecordFilters = {
    ...dates,
    ordering: sort === 'asc' ? 'created_at' : '-created_at',
    scope,
    source_type: source || undefined,
    q: query,
    ...(minutes ? { has_summary: 'true' } : {}),
  }
  const filterKey = JSON.stringify([viewerId, filters])
  /**
   * 两段列表的游标栈放在这一层:视图开关只换渲染形态,不该把翻过的页丢掉
   * (组件级 state 会随 `<section>` / `<tbody>` 换根而重挂)。
   *
   * 筛选条件一变就回到第一页 —— 与原先靠 `key` 重挂组件重置游标是同一效果,
   * 只是这次是显式推导:旧 key 下的游标直接不采纳。
   */
  const [paging, setPaging] = useState<{
    key: string
    ongoing: string[]
    archive: string[]
  }>({ key: filterKey, ongoing: [''], archive: [''] })
  const pages =
    paging.key === filterKey
      ? paging
      : { key: filterKey, ongoing: [''], archive: [''] }
  // Share the archive query/cache with RecordList, including an empty library.
  const archive = useMeetingRecords(viewerId, true, {
    ...filters,
    is_ongoing: minutes ? undefined : 'false',
    cursor: pages.archive.at(-1),
  })
  const sectionCursors = (ongoing: boolean) =>
    ongoing ? pages.ongoing : pages.archive
  const setSectionCursors = (ongoing: boolean, next: string[]) =>
    setPaging({
      ...pages,
      key: filterKey,
      [ongoing ? 'ongoing' : 'archive']: next,
    })
  const renderSection = (ongoing: boolean, isMinutes = false) => (
    <RecordList
      key={`${filterKey}:${ongoing ? 'ongoing' : 'archive'}`}
      viewerId={viewerId}
      filters={filters}
      ongoing={ongoing}
      grid={grid}
      cursors={sectionCursors(ongoing)}
      onCursors={(next) => setSectionCursors(ongoing, next)}
      minutes={isMinutes}
    />
  )
  const scopeValues = minutes
    ? (['owned', 'participated', 'shared'] as const)
    : (['recent', 'owned', 'shared'] as const)
  return (
    <MeetingModuleShell compactNavigation>
      {/* 页壳一律 canvas:钉住的页头在四个栏目页上都是同一档浅灰。 */}
      <main className={canvasShell}>
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
            {/* 页头只有标题:四个一级页都不再带副标题(2026-09-17)。 */}
            <div className={pageHeaderText}>
              <h1 className={pageTitle}>
                {t(minutes ? 'library.minutes' : 'library.notes')}
              </h1>
            </div>
            <div className={headerActions}>
              {!archive.isError && archive.data?.trash_available && (
                <RecordTrashLibrary key={viewerId} viewerId={viewerId} />
              )}
              {/* 搜索框在动作行里、紧挨「搜索会议 AI」的左侧,**没有提交按钮**:
                  回车即搜(清空输入即撤销筛选,见 onChange)。两个页面共用这一份。 */}
              <form
                className={searchForm}
                role="search"
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
              </form>
              {config?.search_ai?.enabled !== false && (
                <Button
                  variant="secondaryText"
                  size="action"
                  icon={<RiSparklingLine size={18} aria-hidden />}
                  onPress={() => openGlobalSearch('ai', 'meetings')}
                >
                  {t('minutesReader.searchMeetings')}
                </Button>
              )}
              {/* 「上传」和「录音」不再挂在这一页上:两个动作都在 AI 录音页
                  (页头同款按钮 + 导航里的固定入口),实录页只负责查/看。 */}
            </div>
          </header>
          {/* 范围筛选走共享分段控件,两个页面统一用 underline:同一档工具按钮,
            与页头动作同高同字号。焦点态、方向键与 Home / End 由基元提供。 */}
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
                appearance="underline"
                density="compact"
              />
            </div>
            <IconToggleButton
              size="icon32"
              label={t('library.filters')}
              isSelected={
                showFilters ||
                Boolean(source || dates.created_from || dates.created_before)
              }
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
          {/* 筛选面板留在工具栏下面:它原先挂在搜索表单里(靠 flexBasis 占满一行),
              搜索框搬进页头之后表单只剩一个输入,面板就跟着独立出来。 */}
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
              <form
                className={css({
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 'md',
                  alignItems: 'center',
                  width: '100%',
                })}
                onSubmit={(event) => {
                  event.preventDefault()
                  try {
                    setDates(recordDateRange(dateDraft.from, dateDraft.through))
                    setDateLabels(dateDraft)
                    setDateError(false)
                  } catch {
                    setDateError(true)
                  }
                }}
              >
                <label className={filterLabel}>
                  {t('library.createdFrom')}
                  <input
                    type="date"
                    className={dateInput}
                    value={dateDraft.from}
                    onChange={(event) =>
                      setDateDraft({ ...dateDraft, from: event.target.value })
                    }
                  />
                </label>
                <label className={filterLabel}>
                  {t('library.createdThrough')}
                  <input
                    type="date"
                    className={dateInput}
                    value={dateDraft.through}
                    onChange={(event) =>
                      setDateDraft({
                        ...dateDraft,
                        through: event.target.value,
                      })
                    }
                  />
                </label>
                <Button type="submit" size="sm">
                  {t('library.applyDates')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="tertiary"
                  onPress={() => {
                    setDateDraft({ from: '', through: '' })
                    setDates({})
                    setDateLabels({ from: '', through: '' })
                    setDateError(false)
                  }}
                >
                  {t('library.clearDates')}
                </Button>
                <p>{t('library.dateHint')}</p>
                {dateError && <p role="alert">{t('library.dateError')}</p>}
              </form>
            </div>
          )}
          {(dates.created_from || dates.created_before) && (
            <p>
              {t('library.createdFrom')}: {dateLabels.from || '…'} ·{' '}
              {t('library.createdThrough')}: {dateLabels.through || '…'}
            </p>
          )}
        </div>
        <div className={listRegion} data-testid="meeting-list-region">
          {grid ? (
            <>
              {!minutes && renderSection(true)}
              {renderSection(false, minutes)}
            </>
          ) : (
            /* 列表视图 = 表格:表头只出现这一次,两段列表是同一个表的两组行。 */
            <table
              className={tableCls}
              data-testid="meeting-records-table"
              aria-label={t(minutes ? 'library.minutes' : 'library.notes')}
            >
              <thead className={tableHead}>
                <tr>
                  <th scope="col">{t('library.table.title')}</th>
                  <th scope="col" className={cx(tableMetaCell, ownerCell)}>
                    {t('library.table.owner')}
                  </th>
                  <th scope="col" className={cx(tableMetaCell, timeCell)}>
                    {t('library.table.modified')}
                  </th>
                  <th
                    scope="col"
                    className={cx(tableMetaCell, timeCell)}
                    aria-sort={sort === 'desc' ? 'descending' : 'ascending'}
                  >
                    <button
                      type="button"
                      className={sortButton}
                      title={t('library.sortByCreated')}
                      onClick={() => setSort(sort === 'desc' ? 'asc' : 'desc')}
                    >
                      <span>{t('library.table.created')}</span>
                      {sort === 'desc' ? (
                        <RiArrowDownSLine size={16} aria-hidden />
                      ) : (
                        <RiArrowUpSLine size={16} aria-hidden />
                      )}
                    </button>
                  </th>
                </tr>
              </thead>
              {!minutes && renderSection(true)}
              {renderSection(false, minutes)}
            </table>
          )}
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
          <PageState
            density="compact"
            description={t('library.unavailable')}
            action={
              <Link href="/meeting" className={homeLink}>
                {t('library.home')}
              </Link>
            }
          />
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
