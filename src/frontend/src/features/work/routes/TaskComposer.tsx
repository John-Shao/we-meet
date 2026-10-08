import { useEffect, useRef, type ReactNode } from 'react'
import {
  RiArrowUpLine,
  RiChatQuoteLine,
  RiFileChartLine,
  RiFileTextLine,
  RiTableLine,
} from '@remixicon/react'

const suggestions = [
  {
    label: '文档整理',
    icon: RiFileTextLine,
    goal: '阅读工作材料，整理核心要点、结论与待确认信息，生成一份结构清晰的 report.md，并标明材料来源。',
  },
  {
    label: '周报',
    icon: RiFileChartLine,
    goal: '整理本周进展、风险和下周计划，生成 report.md。保留未确认和待验收状态，列出缺失信息。',
  },
  {
    label: '表格分析',
    icon: RiTableLine,
    goal: '分析相关表格数据，说明清洗和统计口径，生成 report.md 及可复核的 CSV 或 JSON 结果，保留原始文件。',
  },
  {
    label: '沟通提纲',
    icon: RiChatQuoteLine,
    goal: '根据工作材料整理沟通背景、议程、关键问题与建议话术，生成 report.md。区分已知事实与待确认信息。',
  },
]

export function TaskComposer({
  goal,
  onGoalChange,
  maxLength,
  busy,
  disabled,
  submitLabel,
  tools,
  context,
  options,
  hint,
}: {
  goal: string
  onGoalChange: (value: string) => void
  maxLength: number
  busy: boolean
  disabled: boolean
  submitLabel: string
  tools: ReactNode
  context?: ReactNode
  options?: ReactNode
  hint: ReactNode
}) {
  const input = useRef<HTMLTextAreaElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const menus = () =>
      toolbar.current?.querySelectorAll<HTMLDetailsElement>(
        '.work-composer-menu'
      ) || []
    const positionMenus = () => {
      for (const menu of menus()) {
        if (!menu.open) continue
        const anchor =
          window.getComputedStyle(menu).position === 'static'
            ? toolbar.current!
            : menu
        const rect = anchor.getBoundingClientRect()
        const popover = menu.querySelector<HTMLElement>(
          '.work-composer-popover'
        )
        const bounds = (
          toolbar.current!.closest('.work-task-main') || toolbar.current!
        ).getBoundingClientRect()
        if (popover) {
          const width = popover.getBoundingClientRect().width
          const left = Math.max(
            bounds.left + 8,
            Math.min(rect.left, bounds.right - width - 8)
          )
          menu.style.setProperty('--work-menu-left', `${left - rect.left}px`)
        }
        const below = rect.top < 200
        menu.dataset.placement = below ? 'below' : 'above'
        menu.style.setProperty(
          '--work-menu-space',
          `${Math.max(120, below ? window.innerHeight - rect.bottom - 20 : rect.top - 20)}px`
        )
      }
    }
    const dismiss = (event: PointerEvent) => {
      for (const menu of menus())
        if (!menu.contains(event.target as Node)) menu.open = false
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      for (const menu of menus())
        if (menu.open) {
          menu.open = false
          menu.querySelector('summary')?.focus()
        }
    }
    const selectMenu = (event: MouseEvent) => {
      const summary = (event.target as Element).closest('summary')
      if (!summary || !toolbar.current?.contains(summary)) return
      for (const menu of menus())
        if (menu !== summary.parentElement) menu.open = false
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    document.addEventListener('click', selectMenu)
    const tools = toolbar.current
    tools?.addEventListener('toggle', positionMenus, true)
    window.addEventListener('resize', positionMenus)
    positionMenus()
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', escape)
      document.removeEventListener('click', selectMenu)
      tools?.removeEventListener('toggle', positionMenus, true)
      window.removeEventListener('resize', positionMenus)
    }
  }, [])
  return (
    <>
      <div className="work-composer-shell">
        <div className="work-composer">
          <label className="work-visually-hidden" htmlFor="work-task-goal">
            工作目标
          </label>
          <textarea
            ref={input}
            id="work-task-goal"
            required
            maxLength={maxLength}
            value={goal}
            disabled={busy}
            placeholder="描述你想完成的工作，例如：整理本周进展，生成一份周报…"
            onChange={(event) => onGoalChange(event.target.value)}
          />
          <div className="work-composer-toolbar">
            <div ref={toolbar} className="work-composer-tools">
              {tools}
            </div>
            <button
              type="submit"
              className="work-composer-send"
              disabled={disabled}
              aria-label={submitLabel}
              title={submitLabel}
            >
              <RiArrowUpLine size={23} aria-hidden="true" />
            </button>
          </div>
        </div>
        {context && <div className="work-composer-context">{context}</div>}
      </div>
      {options}
      <p className="work-composer-hint">{hint}</p>
      <div className="work-task-suggestions" aria-label="快捷工作目标">
        {suggestions.map(({ label, icon: Icon, goal: value }) => (
          <button
            type="button"
            key={label}
            disabled={busy}
            onClick={() => {
              onGoalChange(value)
              input.current?.focus()
            }}
          >
            <Icon size={19} aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>
    </>
  )
}
