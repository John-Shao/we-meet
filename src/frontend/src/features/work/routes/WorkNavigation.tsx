import { createContext, useContext, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'wouter'
import {
  RiAddCircleLine,
  RiBriefcaseLine,
  RiChatQuoteLine,
  RiFileChartLine,
  RiFileTextLine,
  RiFolderLine,
  RiFunctionLine,
  RiHistoryLine,
  RiRobot2Line,
  RiTableLine,
  RiTimeLine,
  RiBookOpenLine,
  type RemixiconComponentType,
} from '@remixicon/react'
import { ResizablePanel } from '@/components/ResizablePanel'
import { SubNavHeader, SubNavStrip } from '@/components/SubNav'
import { useCollapsibleSubNav } from '@/components/useCollapsibleSubNav'
import { useMediaQuery } from '@/features/rooms/livekit/hooks/useMediaQuery'

interface WorkModule {
  id: string
  label: string
  icon: RemixiconComponentType
  description: string
  planned?: boolean
}

const groups: { label: string; items: WorkModule[] }[] = [
  {
    label: '工作',
    items: [
      {
        id: 'new',
        label: '新建任务',
        icon: RiAddCircleLine,
        description: '选择一项工作，从材料开始。',
      },
      {
        id: 'tasks',
        label: '我的工作',
        icon: RiHistoryLine,
        description:
          '集中查看进行中、待处理和已完成的工作。统一任务列表即将开放，已有沟通准备任务可在沟通准备中查看。',
        planned: true,
      },
    ],
  },
  {
    label: '日常办公',
    items: [
      {
        id: 'materials',
        label: '工作材料',
        icon: RiFileTextLine,
        description: '上传和核对材料，为后续工作提供背景。',
      },
      {
        id: 'communication',
        label: '沟通准备',
        icon: RiChatQuoteLine,
        description: '根据材料整理背景、议程、问题和建议话术。',
      },
      {
        id: 'weekly',
        label: '周报',
        icon: RiFileChartLine,
        description: '整理本周进展、风险和下周计划，生成可编辑的周报。',
      },
      {
        id: 'spreadsheet',
        label: '表格分析',
        icon: RiTableLine,
        description: '从表格中梳理数据、统计结果和分析结论。',
      },
    ],
  },
  {
    label: '工作空间',
    items: [
      {
        id: 'assistant',
        label: '助理',
        icon: RiRobot2Line,
        description: '连接工作设备，管理个人助理与持续协作。',
        planned: true,
      },
      {
        id: 'projects',
        label: '项目',
        icon: RiFolderLine,
        description: '按项目组织目标、材料、任务与成果。',
        planned: true,
      },
      {
        id: 'capabilities',
        label: '专家·技能·连接器',
        icon: RiFunctionLine,
        description: '发现专家和技能，管理工作中使用的连接器。',
        planned: true,
      },
      {
        id: 'schedules',
        label: '定时任务',
        icon: RiTimeLine,
        description: '安排周期性工作，查看每次运行的记录。',
        planned: true,
      },
      {
        id: 'library',
        label: '成果与资料库',
        icon: RiBookOpenLine,
        description:
          '查找和复用工作资料及成果。统一资料库即将开放，当前可在沟通准备任务中编辑、采纳和下载成果。',
        planned: true,
      },
    ],
  },
]

const hrefFor = (id: string) =>
  id === 'materials' ? '/work' : `/work?view=${id}`

const SidebarContext = createContext<{
  target: HTMLDivElement | null
  closeMobile: () => void
} | null>(null)

// Keep task state and actions in the execution page while rendering in navigation.
export function WorkSidebarSection({ children }: { children: ReactNode }) {
  const sidebar = useContext(SidebarContext)
  if (!sidebar) return <div className="work-sidebar-tasks">{children}</div>
  return sidebar.target
    ? createPortal(
        <div
          className="work-sidebar-section"
          role="presentation"
          onClick={(event) => {
            if ((event.target as Element).closest('[data-work-open-task]'))
              sidebar.closeMobile()
          }}
        >
          {children}
        </div>,
        sidebar.target
      )
    : null
}

export const WorkNavigation = ({
  active,
  children,
}: {
  active: string
  children: ReactNode
}) => {
  const { collapsed, toggle } = useCollapsibleSubNav(
    'we-meet:work-nav-collapsed'
  )
  const compact = useMediaQuery('(max-width: 767px)')
  const [mobileOpen, setMobileOpen] = useState(false)
  const [sidebarTarget, setSidebarTarget] = useState<HTMLDivElement | null>(
    null
  )
  const expanded = compact ? mobileOpen : !collapsed
  const toggleNav = () =>
    compact ? setMobileOpen((value) => !value) : toggle()
  const sidebar = (
    <aside className="work-sidebar" aria-label="工作导航">
      <SubNavHeader
        title="工作"
        onCollapse={toggleNav}
        collapseLabel="收起工作导航"
      />
      <nav aria-label="工作模块" className="work-nav-groups">
        {groups
          .filter((group) => group.items.some((item) => !item.planned))
          .map((group) => (
            <div className="work-nav-group" key={group.label}>
              {group.label !== '工作' && (
                <p className="work-nav-label">{group.label}</p>
              )}
              {group.items
                .filter((item) => !item.planned)
                .map(({ id, label, icon: Icon }) => (
                  <Link
                    key={id}
                    href={hrefFor(id)}
                    className="work-nav-link"
                    aria-current={active === id ? 'page' : undefined}
                    onClick={() => setMobileOpen(false)}
                  >
                    <Icon size={19} aria-hidden="true" />
                    <span>{label}</span>
                  </Link>
                ))}
            </div>
          ))}
        <details
          className="work-nav-more"
          open={groups.some((group) =>
            group.items.some((item) => item.id === active && item.planned)
          )}
        >
          <summary>
            更多<span>筹备中的功能</span>
          </summary>
          {groups
            .flatMap((group) => group.items)
            .filter((item) => item.planned)
            .map(({ id, label, icon: Icon }) => (
              <Link
                key={id}
                href={hrefFor(id)}
                className="work-nav-link"
                aria-current={active === id ? 'page' : undefined}
                onClick={() => setMobileOpen(false)}
              >
                <Icon size={19} aria-hidden="true" />
                <span>{label}</span>
                <small>待开放</small>
              </Link>
            ))}
        </details>
      </nav>
      <div ref={setSidebarTarget} className="work-sidebar-tasks" />
    </aside>
  )
  return (
    <SidebarContext.Provider
      value={{ target: sidebarTarget, closeMobile: () => setMobileOpen(false) }}
    >
      <div className="work-workspace">
        {!expanded ? (
          <SubNavStrip onExpand={toggleNav} expandLabel="展开工作导航" />
        ) : compact ? (
          sidebar
        ) : (
          <ResizablePanel
            storageKey="we-meet:work-nav-width"
            defaultWidth={250}
            min={240}
            max={320}
          >
            {sidebar}
          </ResizablePanel>
        )}
        <div className="work-content" hidden={compact && mobileOpen}>
          {children}
        </div>
      </div>
    </SidebarContext.Provider>
  )
}

export const WorkModulePage = ({ view }: { view: string }) => {
  const group = groups.find((item) =>
    item.items.some((module) => module.id === view)
  )
  const module = group?.items.find((item) => item.id === view)
  if (view === 'new')
    return (
      <section className="work-materials" aria-label="新建工作任务">
        <header className="work-heading">
          <div>
            <p className="work-eyebrow">日常办公</p>
            <h1>今天想完成什么工作？</h1>
            <p>准备好材料，选择一项工作开始。</p>
          </div>
        </header>
        <div className="work-entry-grid">
          {groups[1].items.map(
            ({ id, label, icon: Icon, description, planned }) => (
              <Link href={hrefFor(id)} key={id} className="work-entry-card">
                <Icon size={26} aria-hidden="true" />
                <h2>
                  {label}
                  {planned && <small>待开放</small>}
                </h2>
                <p>{description}</p>
                <span>{planned ? '了解功能' : '开始使用'} →</span>
              </Link>
            )
          )}
        </div>
      </section>
    )
  const Icon = module?.icon ?? RiBriefcaseLine
  return (
    <section
      className="work-materials"
      aria-label={module?.label ?? '未找到工作模块'}
    >
      <header className="work-heading">
        <div>
          <p className="work-eyebrow">{group?.label ?? '工作'}</p>
          <h1>{module?.label ?? '未找到工作模块'}</h1>
        </div>
      </header>
      <div className="work-module-placeholder">
        <Icon size={40} aria-hidden="true" />
        <h2>{module ? '功能筹备中' : '这个入口暂不可用'}</h2>
        <p>{module?.description ?? '请从工作导航选择其他模块。'}</p>
        <p className="work-muted">你可以先上传工作材料，或使用沟通准备。</p>
        <div className="work-actions">
          <Link
            className="work-button work-primary"
            href="/work?view=communication"
          >
            进入沟通准备
          </Link>
          <Link className="work-button" href="/work">
            查看工作材料
          </Link>
        </div>
      </div>
    </section>
  )
}
