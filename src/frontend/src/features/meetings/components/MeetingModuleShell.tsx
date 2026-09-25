import type { ReactNode } from 'react'
import { Screen } from '@/layout/Screen'
import { MeetingNavPanel } from './MeetingNavPanel'
import { moduleContent, moduleRow } from './libraryStyles'
import { css } from '@/styled-system/css'

/**
 * 「会议」二级页(录音 / 会议实录 / 智能纪要)的统一外壳:
 * 宽屏左列保留 `MeetingNavPanel`；窄屏让出正文空间，使用栏目入口或详情页返回。
 *
 * 存在的理由:这三级页原先各自 `<Screen>` 一把,点进来左侧那列功能导航就消失,
 * 用户只能靠浏览器后退 —— 面板必须跟着路由一起留在屏幕上。
 *
 * 进会预览页(rooms/Join)的版面是一套居中的 hero,没法直接套这个壳,
 * 那里手动拼 moduleRow/moduleContent(见 Join.tsx),两处保持同一套伸缩规则。
 */
export const MeetingModuleShell = ({ children }: { children: ReactNode }) => (
  <Screen>
    <div className={moduleRow}>
      <div className={css({ display: { base: 'none', md: 'flex' } })}>
        <MeetingNavPanel />
      </div>
      <div className={moduleContent}>{children}</div>
    </div>
  </Screen>
)
