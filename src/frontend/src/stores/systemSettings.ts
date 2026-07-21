import { proxy } from 'valtio'

/** 系统设置弹窗(AppRail「设置」,SettingsDialog)的节。 */
export type SystemSettingsSection =
  | 'general'
  | 'account'
  | 'meeting'
  | 'calendar'
  | 'agreement'

type State = {
  open: boolean
  /** 打开时要定位到的节;关闭时清空,下次默认「通用」。 */
  section?: SystemSettingsSection
}

/**
 * 系统设置弹窗的全局开关(P8 设置收敛):所有设置集中在 SettingsDialog,
 * 各模块内的设置按钮(如日历页齿轮)只是快捷入口——通过这里打开弹窗并
 * 定位到对应节。对齐会中 Extended 弹窗的 settingsStore(valtio)模式。
 */
export const systemSettingsStore = proxy<State>({
  open: false,
  section: undefined,
})

export const openSystemSettings = (section?: SystemSettingsSection) => {
  if (section) systemSettingsStore.section = section
  systemSettingsStore.open = true
}
