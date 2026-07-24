import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'wouter'
import { useSnapshot } from 'valtio'
import { css } from '@/styled-system/css'
import { useConfig } from '@/api/useConfig'
import { useConfirm } from '@/components/ConfirmProvider'
import { Screen } from '@/layout/Screen'
import { resolveTheme, themeStore } from '@/stores/theme'
import { buildDocCardBody } from '@/features/im/components/docCard'
import { ForwardDialog } from '@/features/im/components/ForwardDialog'
import { useForwardConversations } from '@/features/im/hooks/useForwardConversations'

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
  const { t: tIm } = useTranslation('im')
  const { docId } = useParams<{ docId?: string }>()
  const { data: config } = useConfig()
  const docsUrl = config?.docs?.url
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const { mode } = useSnapshot(themeStore)
  const colorScheme = resolveTheme(mode)
  const { alert: showAlert } = useConfirm()
  const { client, conversations } = useForwardConversations()
  // 分享云文档到聊天(入口 B):docs 里点「分享到聊天」→ postMessage 过来,
  // 弹会话选择器;选完直接用 IM SDK 单例发卡片,docs 侧全程不知道 IM 存在。
  const [shareDoc, setShareDoc] = useState<{
    docId: string
    title: string
    url: string
  } | null>(null)
  // src 只用首帧主题:?theme= 让 docs embedderTheme 首屏即对色(免闪);运行时切换走
  // 下方 postMessage,不改 src 以免 iframe 整页重载。
  const initialScheme = useRef(colorScheme).current

  // ?embed=1 让 docs 收敛掉自带的用户区(docs 的 LeftPanelFooter);?lang= 用 meet 当前
  // 语言驱动 docs(docs i18next 的 querystring 探测);?theme= 传初始深浅。去尾斜杠避免双斜杠。
  // 分享云文档到聊天:带 docId 时深链到具体文档(/docs/{docId}/),否则落文档列表首页。
  const docsBase = docsUrl?.replace(/\/+$/, '') ?? ''
  const embedPath = docId ? `/docs/${docId}/` : '/'
  const embedTarget = docsBase
    ? `${docsBase}${embedPath}?embed=1&lang=${encodeURIComponent(
        i18n.language,
      )}&theme=${initialScheme}`
    : ''
  // 与 App 端(we-meet-android DocsScreen.docsUrl)对齐:经 docs 的 OIDC
  // authenticate 入口进站,而非裸 `/`。无 docs 会话的浏览器(新浏览器/无痕窗)
  // 直接进 `/` 会被 docs 前端甩到 /home/ 英文营销页;authenticate 则拿已有
  // Keycloak 会话(meet/docs/id 同注册域,iframe 内 cookie 照常携带)服务端
  // 静默换 docs 会话,302 回 returnTo 直达文档列表,营销页整链路不出现。
  const embedSrc = embedTarget
    ? `${docsBase}/api/v1.0/authenticate/?returnTo=${encodeURIComponent(embedTarget)}`
    : ''

  // 同域把当前深浅同步给 iframe 内 docs:主题变化即发;docs 挂载后会发
  // wemeet-theme-ready 请求补发(规避 iframe 尚未就绪的竞态)。
  useEffect(() => {
    const post = () => {
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'wemeet-theme', theme: colorScheme },
        '*',
      )
    }
    post()
    const onMsg = (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === 'wemeet-theme-ready') {
        post()
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [colorScheme])

  // 分享云文档到聊天(入口 B):docs 发来 wemeet-share-doc → 弹会话选择器。
  // 与上面的主题同步不同,这条消息会触发实际发消息动作,所以额外校验来源
  // origin 等于 docs 域(主题同步是纯展示,坏了也无所谓;这个不行)。
  useEffect(() => {
    if (!docsBase) return
    let docsOrigin: string
    try {
      docsOrigin = new URL(docsBase).origin
    } catch {
      return
    }
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== docsOrigin) return
      const data = e.data as
        | { type?: string; docId?: string; title?: string; url?: string }
        | null
      if (data?.type !== 'wemeet-share-doc' || !data.docId || !data.url) return
      setShareDoc({
        docId: data.docId,
        title: data.title || '',
        url: data.url,
      })
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [docsBase])

  return (
    <Screen header footer={false}>
      {docsUrl && (
        <iframe
          ref={iframeRef}
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
      {shareDoc && (
        <ForwardDialog
          conversations={conversations}
          previewText={shareDoc.title || tIm('preview.doc')}
          onClose={() => setShareDoc(null)}
          onConfirm={(cids) => {
            const doc = shareDoc
            setShareDoc(null)
            void (async () => {
              try {
                for (const cid of cids) {
                  await client.sendText(
                    cid,
                    buildDocCardBody({ id: doc.docId, title: doc.title, url: doc.url }),
                    { contentType: 'doc-card' },
                  )
                }
              } catch {
                void showAlert({ message: tIm('docPicker.error') })
              }
            })()
          }}
        />
      )}
    </Screen>
  )
}
