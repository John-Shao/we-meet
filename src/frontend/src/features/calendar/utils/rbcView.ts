import type { View } from 'react-big-calendar'

/**
 * 关周末时把周视图映射到 rbc 内置 work_week(周一~周五 5 列);其余视图透传。
 * app 层 view 恒为 'week',仅渲染层收敛(见 CalendarGrid)。抽成纯函数便于单测
 * 锁定「week+关→work_week、week+开→week、其余不变」。
 */
export const resolveRbcView = (view: View, showWeekend: boolean): View =>
  view === 'week' && !showWeekend ? ('work_week' as View) : view
