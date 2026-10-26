import { createContext, useContext, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'wouter'
import { RiAddCircleLine, RiBriefcaseLine } from '@remixicon/react'
import { ResizablePanel } from '@/components/ResizablePanel'
import { SubNavHeader, SubNavStrip } from '@/components/SubNav'
import { useCollapsibleSubNav } from '@/components/useCollapsibleSubNav'
import { useMediaQuery } from '@/features/rooms/livekit/hooks/useMediaQuery'

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
        <div className="work-nav-group">
          <Link
            href="/work"
            className="work-nav-link"
            aria-current={active === 'new' ? 'page' : undefined}
            onClick={() => setMobileOpen(false)}
          >
            <RiAddCircleLine size={19} aria-hidden="true" />
            <span>新建任务</span>
          </Link>
        </div>
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

export const WorkModulePage = () => (
  <section className="work-page" aria-label="这个入口暂不可用">
    <header className="work-heading">
      <div>
        <p className="work-eyebrow">工作</p>
        <h1>这个入口暂不可用</h1>
        <p>请从工作导航进入新建任务。</p>
      </div>
    </header>
    <div className="work-module-placeholder">
      <RiBriefcaseLine size={40} aria-hidden="true" />
      <h2>直接开始一项工作</h2>
      <p className="work-muted">描述目标，由工作助理生成可核对和编辑的成果。</p>
      <div className="work-actions">
        <Link className="work-button work-primary" href="/work">
          新建任务
        </Link>
      </div>
    </div>
  </section>
)
