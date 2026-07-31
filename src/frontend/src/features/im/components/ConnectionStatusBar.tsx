import { useTranslation } from 'react-i18next'
import type { ConnectionState } from '@jusi/light-im-sdk'

import { css, cx } from '@/styled-system/css'

const barCls = css({
  paddingX: '1rem',
  paddingY: '0.5rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
  fontSize: '0.875rem',
  color: 'greyscale.800',
})

// 每个状态一条独立的 css(),而**不是** `backgroundColor: stateColors[state]`。
//
// 两个坑叠在一起,之前这条状态栏有一半档位是完全没有底色的:
// ① panda 是静态提取 —— 动态取值它看不到字面量,一个原子类都不生成。原来那些
//    档位能出颜色,只是因为别的文件恰好用过同名 token 把类带了出来;
// ② warning 组根本没有数字档(见 panda.config,刻意不 spread amber),
//    `warning.100` 连 CSS 变量都不存在,「重连中」双重踩空。
//
// 底色一律走 *.subtle:它们自带 base/_dark 两套。这里的文字是会翻转的
// greyscale.800,底色不跟着翻就是深色下浅灰压浅底。
const stateBgCls: Record<ConnectionState, string> = {
  disconnected: css({ backgroundColor: 'greyscale.200' }),
  connecting: css({ backgroundColor: 'primary.subtle' }),
  connected: css({ backgroundColor: 'success.subtle' }),
  reconnecting: css({ backgroundColor: 'warning.subtle' }),
  auth_failed: css({ backgroundColor: 'danger.subtle' }),
}
const fallbackBgCls = css({ backgroundColor: 'greyscale.100' })

export const ConnectionStatusBar = ({ state }: { state: ConnectionState }) => {
  const { t } = useTranslation('im')
  return (
    <div
      // barCls 不设 background-color,与状态类无同属性冲突,cx 叠加安全。
      className={cx(barCls, stateBgCls[state] ?? fallbackBgCls)}
      data-testid="im-connection-status"
    >
      {t(`connection.${state}`)}
    </div>
  )
}
