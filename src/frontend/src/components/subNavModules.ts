import { useCollapsibleSubNav } from './useCollapsibleSubNav'

/**
 * 各模块二级导航栏收起态的 storage key —— **一处定义**。
 *
 * 必须集中：收起按钮在模块二级导航栏的栏头里，展开按钮在**内容标题栏**里，两处
 * （有时还跨文件）都要读同一个 key，key 分散写就会各收各的。值沿用各模块原先的
 * 字符串，用户的收起状态因此不会被这次重构重置。
 */
export const SUB_NAV_KEYS = {
  im: 'we-meet:im-nav-collapsed',
  meetings: 'we-meet:meeting-nav-collapsed',
  calendar: 'we-meet:calendar-sidebar-collapsed',
  approval: 'we-meet:approval-nav-collapsed',
  tasks: 'we-meet:task-nav-collapsed',
  contacts: 'we-meet:contacts-nav-collapsed',
} as const

export type SubNavModule = keyof typeof SUB_NAV_KEYS

/** 读 / 切换某个模块的二级导航栏收起态（同 key 的所有使用点共享同一份状态）。 */
export const useModuleSubNav = (module: SubNavModule) =>
  useCollapsibleSubNav(SUB_NAV_KEYS[module])
