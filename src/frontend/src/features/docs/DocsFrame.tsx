import { useTranslation } from 'react-i18next'
import { css } from '@/styled-system/css'
import { useConfig } from '@/api/useConfig'

/**
 * 云文档:在 meet 导航框架内 iframe 嵌入 La Suite Docs(docs.<域名>),取代原来的
 * 新标签跳转,消除「割裂感」。
 *
 * SSO 免登无需改 cookie:meet / docs / id 三个子域同属一个注册域(we-meet.online),
 * 浏览器视为 same-site → iframe 内的 OIDC 握手(docs→Keycloak→docs 的 302)会照常
 * 携带 Keycloak 会话 + docs 会话 cookie。docs 侧已放行 frame-ancestors 允许 meet 嵌入
 * (we-meet-docs: conf/default.conf 的 CSP + settings 的 CONTENT_SECURITY_POLICY)。
 *
 * docsUrl 缺失(后端未配 DOCS_API_URL)时导航入口本就不显示;直连 /docs 则渲染空。
 */
export const DocsRoute = () => {
  const { t } = useTranslation('docs')
  const { data: config } = useConfig()
  const docsUrl = config?.docs?.url
  // docsUrl 缺失时渲染空(导航入口本就隐藏;直连 /docs 才可能到这)。空 fragment
  // 满足路由 Component 的 () => JSX.Element 契约。
  if (!docsUrl) return <></>

  return (
    <iframe
      src={docsUrl}
      title={t('nav.title')}
      // 内容区(Layout 的 <main>)是 flex 列;flex:1 + minHeight:0 让 iframe 铺满可用高度。
      className={css({
        flex: 1,
        width: '100%',
        minHeight: 0,
        border: 'none',
        display: 'block',
      })}
      allow="clipboard-read; clipboard-write; fullscreen"
    />
  )
}
