import { createContext, useContext, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'wouter'
import {
  RiAddCircleLine,
  RiBriefcaseLine,
  RiChatQuoteLine,
  RiFileTextLine,
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
        {groups.map((group) => (
          <div className="work-nav-group" key={group.label}>
            {group.label !== '工作' && (
              <p className="work-nav-label">{group.label}</p>
            )}
            {group.items.map(({ id, label, icon: Icon }) => (
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
          {groups[1].items.map(({ id, label, icon: Icon, description }) => (
            <Link href={hrefFor(id)} key={id} className="work-entry-card">
              <Icon size={26} aria-hidden="true" />
              <h2>{label}</h2>
              <p>{description}</p>
              <span>开始使用 →</span>
            </Link>
          ))}
        </div>
      </section>
    )
  return (
    <section className="work-materials" aria-label="这个入口暂不可用">
      <header className="work-heading">
        <div>
          <p className="work-eyebrow">工作</p>
          <h1>这个入口暂不可用</h1>
          <p>请从工作导航选择已开放的工作模块。</p>
        </div>
      </header>
      <div className="work-module-placeholder">
        <RiBriefcaseLine size={40} aria-hidden="true" />
        <h2>你可以先处理材料</h2>
        <p className="work-muted">上传并核对工作材料，或直接开始沟通准备。</p>
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
