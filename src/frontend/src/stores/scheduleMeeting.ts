import { proxy } from 'valtio'

type State = {
  open: boolean
}

/**
 * 「新建日程」弹窗(日历的 CreateEventDialog)的全局开关。
 *
 * 为什么不放在面板自己的 useState:预约会议现在要**先跳回 /meeting 再弹窗**,
 * 而面板在路由切换时会重新挂载 —— 二级页那份卸载、首页那份新建。局部 state
 * 活不过这次切换,结果就是按下按钮安静地回到首页、弹窗没了。
 * 换成 valtio store 后,谁来渲染面板都能读到同一个 open。
 * 与 `openSystemSettings`(系统设置弹窗)是同一套做法。
 *
 * 同一时刻只会挂载一个 MeetingNavPanel,所以也只会渲染一个弹窗实例。
 */
export const scheduleMeetingStore = proxy<State>({ open: false })

export const openScheduleMeeting = () => {
  scheduleMeetingStore.open = true
}

export const closeScheduleMeeting = () => {
  scheduleMeetingStore.open = false
}
