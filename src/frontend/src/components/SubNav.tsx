import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  RiArrowLeftDoubleLine,
  RiArrowRightDoubleLine,
  type RemixiconComponentType,
} from '@remixicon/react'

import { css } from '@/styled-system/css'
import { IconButton } from '@/primitives'
import { TITLE_BAR_MIN_HEIGHT } from './TitleBar'

/**
 * 二级导航栏的**共享栏头**（2026-09-17 起，以「通讯录」左栏为基准的一处定义）。
 *
 * 各模块原先各写各的：标题 16px 与 18px 两种、栏头内边距 16/12 与「aside 内边距 +
 * 标题再补一档」两种，标题因此落在 16 / 20 / 28px 三个位置上；收起按钮也只有通讯录
 * 和日历有，位置还分别在栏头栏外与内容工具栏里。现在统一走这里：
 *
 *   ┌ 16px ─────────────────────────── 12px ┐
 *   │ 标题 16px / bold          动作… «收起 │
 *   └──────────────────────────────────────┘
 *
 * 收起后由 `SubNavStrip` 顶替整栏：一条 36px 窄条，「展开」按钮就在里面 —— 任何
 * 视图下都找得到展开入口（通讯录的窄条也是这个尺寸）。
 *
 * **不要再在模块里手写这一栏**：基准数字写在下面的样式里，改这里等于改五个模块。
 */

/** 标题字号/字重与「通讯录」`ContactsSidebar` 的栏头一致。 */
const headerCls = css({
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'sm',
  paddingX: 'lg',
  paddingY: 'sm',
  // 栏高与内容区标题栏(TitleBar)统一(一处定义,见 TITLE_BAR_MIN_HEIGHT)——
  // 一级页左栏与右栏两条头同高。
  minHeight: TITLE_BAR_MIN_HEIGHT,
})

const titleCls = css({
  textStyle: 'titleMedium',
  fontWeight: 'bold',
  color: 'text.primary',
  margin: 0,
})

const headerActionsCls = css({
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 'xxs',
})

const stripCls = css({
  flexShrink: 0,
  width: '36px',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  paddingTop: 'md',
  borderRight: '1px solid token(colors.border.subtle)',
  backgroundColor: 'subNavBg',
})

/**
 * 栏头：左标题、右动作（模块自己的图标钮）+ 收起按钮。
 *
 * `collapseLabel` 默认取 `shell` 命名空间的「收起导航栏」—— 五个模块因此念同一句话。
 *
 * 图标固定 `«`(`RiArrowLeftDoubleLine`)，与窄条里的 `»` 互为镜像；**双箭头这一族
 * 专属二级导航栏**，一级轨道（整条 rail）另有面板图形，并排时不会混。
 */
export const SubNavHeader = ({
  title,
  children,
  onCollapse,
  collapseLabel,
  collapseTestId,
}: {
  title: ReactNode
  /** 栏头右侧的模块动作（图标钮），排在收起按钮左侧。 */
  children?: ReactNode
  onCollapse: () => void
  collapseLabel?: string
  collapseTestId?: string
}) => {
  const { t } = useTranslation('shell')
  return (
    <div className={headerCls}>
      <h2 className={titleCls}>{title}</h2>
      <div className={headerActionsCls}>
        {children}
        <IconButton
          size="icon28"
          label={collapseLabel ?? t('collapse')}
          onPress={onCollapse}
          data-testid={collapseTestId}
        >
          <RiArrowLeftDoubleLine size={16} aria-hidden="true" />
        </IconButton>
      </div>
    </div>
  )
}

/**
 * 收起后的 36px 窄条：只放一颗「展开」。
 *
 * 图标与栏头的收起按钮**同族镜像**:收起 `«`(`RiArrowLeftDoubleLine`)、
 * 展开 `»`(`RiArrowRightDoubleLine`) —— 同一个控件两个状态只反方向,用户不用重新认;
 * 双箭头这一族专属于**二级导航栏**(一级轨道用面板图形,见 layout/AppRail.tsx)。
 */
export const SubNavStrip = ({
  onExpand,
  expandLabel,
  testId,
  icon: Icon = RiArrowRightDoubleLine,
}: {
  onExpand: () => void
  expandLabel?: string
  testId?: string
  /** 个别模块的展开图标（默认 `RiArrowRightDoubleLine`，与栏头那颗 `«` 镜像）。 */
  icon?: RemixiconComponentType
}) => {
  const { t } = useTranslation('shell')
  return (
    <div className={stripCls}>
      <IconButton
        size="icon28"
        label={expandLabel ?? t('expand')}
        onPress={onExpand}
        data-testid={testId}
      >
        <Icon size={16} aria-hidden="true" />
      </IconButton>
    </div>
  )
}
