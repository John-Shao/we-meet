import { useTranslation } from 'react-i18next'
import { css } from '@/styled-system/css'
import { useConfig } from '@/api/useConfig'
import { Screen } from '@/layout/Screen'

/**
 * 云文档:在 meet 导航框架内 iframe 嵌入 La Suite Docs(docs.<域名>),取代原来的
 * 新标签跳转,消除「割裂感」。
 *
 * SSO 免登无需改 cookie:meet / docs / id 三个子域同属一个注册域(we-meet.online),
 * 浏览器视为 same-site → iframe 内的 OIDC 握手(docs→Keycloak→docs 的 302)会照常
 * 携带 Keycloak 会话 + docs 会话 cookie。docs 侧已放行 frame-ancestors 允许 meet 嵌入
 * (we-meet-docs: conf/default.conf 的 CSP + settings 的 CONTENT_SECURITY_POLICY)。
 *
 * 用 <Screen> 包裹以在挂载时置 layoutStore.showHeader=true —— 否则冷启动/硬刷 /docs
 * 时 showHeader 停在默认 false,Layout 走「无一级导航」分支,左侧 AppRail 会消失(点击
 * 进入时因上一页已把 showHeader 置 true 而侥幸正常,硬刷才暴露)。工作区 rail 布局本就
 * 不渲染 Footer,故 footer 关掉。
 */
export const DocsRoute = () => {
  const { t, i18n } = useTranslation('docs')
  const { data: config } = useConfig()
  const docsUrl = config?.docs?.url

  // ?embed=1 让 docs 收敛掉自带的用户区(docs 的 LeftPanelFooter);?lang= 用 meet 当前
  // 语言驱动 docs(docs i18next 的 querystring 探测)。去尾斜杠避免出现双斜杠。
  const embedSrc = docsUrl
    ? `${docsUrl.replace(/\/+$/, '')}/?embed=1&lang=${encodeURIComponent(
        i18n.language,
      )}`
    : ''

  return (
    <Screen header footer={false}>
      {docsUrl && (
        <iframe
          src={embedSrc}
          title={t('nav.title')}
          // 内容区(Layout 的 <main>)是 flex 列;flex:1 + minHeight:0 让 iframe 铺满。
          className={css({
            flex: 1,
            width: '100%',
            minHeight: 0,
            border: 'none',
            display: 'block',
          })}
          allow="clipboard-read; clipboard-write; fullscreen"
        />
      )}
    </Screen>
  )
}
