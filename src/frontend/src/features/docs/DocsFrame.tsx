import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'wouter'
import { useSnapshot } from 'valtio'
import { css } from '@/styled-system/css'
import { useConfig } from '@/api/useConfig'
import { Button } from '@/primitives'
import { Screen } from '@/layout/Screen'
import { resolveTheme, themeStore } from '@/stores/theme'
import { authUrl } from '@/features/auth'
import { buildDocCardBody } from '@/features/im/components/docCard'
import { ShareToChatDialog } from '@/features/im/components/ShareToChatDialog'
import { grantDocAccess } from '@/features/im/api/grantDocAccess'
import { openGlobalSearch } from '@/layout/globalSearchBus'
import { fetchDocsSessionUrl } from './api/docsSession'

/** 内嵌协议版本。docs 侧 useEmbedShell 发的 wemeet-embed-hello 带同名字段。 */
const HOST_PROTOCOL = 1

/**
 * 宿主(meet web)向 docs 宣告的能力。docs 据此决定要不要收敛自带入口 ——
 * 譬如只有宣告了 `global-search`,它才会隐藏自己的搜索按钮改把 Ctrl+K 转发过来。
 * 改动需与 we-meet-docs `hooks/useEmbedShell.tsx` 的消费侧同步。
 */
const HOST_FEATURES = ['global-search', 'shell-nav', 'route-sync'] as const

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  // 分享云文档到聊天(入口 B):docs 里点「分享到聊天」→ postMessage 过来,
  // 弹会话选择器;选完直接用 IM SDK 单例发卡片,docs 侧全程不知道 IM 存在。
  // 会话列表/IM 连接由 ShareToChatDialog 自己拉,所以只有真的要分享时才建连,
  // 单纯逛文档不再顺带开一条 IM 连接。
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
  // 会触发实际动作的双向消息(收分享请求 / 回发授权已变更)都锚在这个 origin 上,
  // 不用 '*'。配置缺失或不是合法 URL 时为空字符串 → 相关消息通道直接不启用。
  const docsOrigin = (() => {
    try {
      return docsBase ? new URL(docsBase).origin : ''
    } catch {
      return ''
    }
  })()
  // Docs 站内**当前**落地路径。iframe 的 src 只由它 + reloadKey 决定 —— 刻意**不**让
  // meet 路由的 docId 直接进换票 effect 的依赖:下面「地址栏跟随 docs」会 replaceState,
  // 而 wouter v3 monkey-patch 了 replaceState 并派发事件(use-browser-location.js:71)
  // → useParams().docId 随之变化。docId 若还在依赖里,**每点开一篇子文档都会重新换票 +
  // iframe 整页重载**,表现为「云文档闪一下白」。要重载时一律显式 setReloadKey。
  const currentPathRef = useRef(docId ? `/docs/${docId}/` : '/')
  // Docs 站内相对落地路径(带 embed/lang/theme),两条进站方式共用:
  // 票据引导把它当 next 透传(query 全程不丢),authenticate 兜底那条则拼成绝对 URL。
  const buildRelative = useCallback(
    (path: string) =>
      `${path}?embed=1&lang=${encodeURIComponent(i18n.language)}&theme=${initialScheme}`,
    [i18n.language, initialScheme],
  )
  // 与 App 端(we-meet-android DocsScreen.docsUrl)对齐:经 docs 的 OIDC
  // authenticate 入口进站,而非裸 `/`。无 docs 会话的浏览器(新浏览器/无痕窗)
  // 直接进 `/` 会被 docs 前端甩到 /home/ 英文营销页;authenticate 则拿已有
  // Keycloak 会话(meet/docs/id 同注册域,iframe 内 cookie 照常携带)服务端
  // 静默换 docs 会话,302 回落地页,营销页整链路不出现。
  // ⚠️ 参数名必须是 `next`(docs authenticate 走 mozilla-django-oidc,认 `next`;
  // 前端 gotoSilentLogin 亦用 `next`)。曾误用 `returnTo` → 被忽略、一律落 `/`
  // (列表),深链打不开分享的文档 + embed/lang/theme query 全丢(靠 UA 兜底)。
  //
  // ⚠️ 但 authenticate 只是**兜底**:它赌浏览器里有 KC 会话 cookie,而 meet 的登录态
  // 未必留下过这份 cookie(手机号 OTP / 扫码登录压根不建 KC 会话;走过 OIDC 的也只是
  // 会话 cookie,关掉浏览器就没)。赌输时 iframe 会被甩到 KC 登录页,再被 KC 自己的
  // `frame-ancestors 'self'` 挡死 —— 白屏 + 一条 CSP 报错,用户无从自救。首选进站方式
  // 因此改成下面的票据引导(fetchDocsSessionUrl),这条只在票据拿不到时用。
  const buildFallbackSrc = useCallback(
    (relative: string) =>
      docsBase
        ? `${docsBase}/api/v1.0/authenticate/?next=${encodeURIComponent(
            `${docsBase}${relative}`,
          )}`
        : '',
    [docsBase],
  )

  // 首选进站:后端用调用者身份换一张 Docs 一次性票据,iframe 直接带票据进站 ——
  // 云文档的登录态从此跟随 meet 自己的登录态,与浏览器里有没有 KC 会话无关。
  // null = 还在换票;换不到(Docs 未接/不可达)则退回 authenticate 兜底。
  const [bootstrapSrc, setBootstrapSrc] = useState<string | null>(null)
  // docs 就绪信号迟迟不来 = 进站被挡(最常见就是上面那条 KC 登录页 CSP)。
  const [stalled, setStalled] = useState(false)
  // 需要**整页重载** iframe 时才 +1:重试、切界面语言、以及 docs 不支持软导航时的深链跳转。
  const [reloadKey, setReloadKey] = useState(0)
  // docs 是否宣告支持站内软导航(能力握手,见下)。老镜像不发 hello → 保持 false → 走整页重载。
  const [docsRouteSync, setDocsRouteSync] = useState(false)

  useEffect(() => {
    if (!docsBase) return
    let cancelled = false
    setBootstrapSrc(null)
    setStalled(false)
    // 从 ref 读当前路径而不是从 props 算:换票只该由 reloadKey / 语言 / 配置驱动。
    const relative = buildRelative(currentPathRef.current)
    void fetchDocsSessionUrl(relative).then((url) => {
      if (cancelled) return
      setBootstrapSrc(url ?? buildFallbackSrc(relative))
    })
    return () => {
      cancelled = true
    }
  }, [docsBase, buildRelative, buildFallbackSrc, reloadKey])

  // meet 侧路由变化(全局搜索命中、doc-card 深链、rail 点「云文档」)→ 让 iframe 跟上。
  // docs 支持软导航就发 wemeet-navigate(不重载、不重新换票);否则退回整页重载。
  //
  // 守卫 target === currentPathRef:地址栏是被 docs 的 route-changed 用 replaceState
  // 同步过来的,wouter 会把它回流成 docId 变化 —— 不拦就是「docs 通知 meet → meet 又
  // 通知 docs」的回声循环。
  useEffect(() => {
    const target = docId ? `/docs/${docId}/` : '/'
    if (target === currentPathRef.current) return
    currentPathRef.current = target
    const win = iframeRef.current?.contentWindow
    if (docsRouteSync && win && docsOrigin) {
      win.postMessage({ type: 'wemeet-navigate', path: target }, docsOrigin)
      return
    }
    setReloadKey((n) => n + 1)
  }, [docId, docsRouteSync, docsOrigin])

  // 兜底:docs 在 iframe 里挂载后会 postMessage 一条 wemeet-theme-ready。整条进站
  // (换票 + 加载)走完还等不到,就说明那一帧根本没跑起 docs —— 被 CSP 挡掉的 KC
  // 登录页不会发任何消息,换票请求挂住也一样 —— 盖一层可操作的遮罩,别让用户对着
  // 白屏。计时从挂载起算(而不是从 iframe 有了 src 起算),这样换票那步卡住也算数;
  // 12s 给得足够宽,免得把"慢"误判成"挂"。
  useEffect(() => {
    if (!docsBase || !docsOrigin) return
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== docsOrigin) return
      if ((e.data as { type?: string } | null)?.type === 'wemeet-theme-ready') {
        setStalled(false)
        window.clearTimeout(timer)
      }
    }
    const timer = window.setTimeout(() => setStalled(true), 12_000)
    window.addEventListener('message', onMsg)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('message', onMsg)
    }
  }, [docsBase, docsOrigin, reloadKey])

  const retry = useCallback(() => {
    setStalled(false)
    setReloadKey((n) => n + 1)
  }, [])

  // 能力握手:docs 挂载后发 wemeet-embed-hello 宣告自己支持哪些协议,宿主回
  // wemeet-host-hello 宣告自己支持哪些。**能力驱动,不是版本驱动** —— 三端发布
  // 速度差两个数量级(meet web 分钟级 / docs 镜像小时级 / App 周级),按版本猜对方
  // 会不会某条协议,迟早撞上「docs 把自带入口收了、宿主却还不提供替代」的死角。
  //
  // 与既有的 wemeet-theme-ready **并行**,不替换它 —— 上面那条 12s 兜底依赖它。
  useEffect(() => {
    if (!docsOrigin) return
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== docsOrigin) return
      const data = e.data as
        | { type?: string; features?: unknown; docId?: unknown }
        | null
      if (data?.type !== 'wemeet-embed-hello') return
      const features = Array.isArray(data.features) ? data.features : []
      setDocsRouteSync(features.includes('route-sync'))
      iframeRef.current?.contentWindow?.postMessage(
        {
          type: 'wemeet-host-hello',
          protocol: HOST_PROTOCOL,
          platform: 'web',
          features: HOST_FEATURES,
        },
        docsOrigin,
      )
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [docsOrigin])

  // 地址栏跟随 docs 站内导航:用户在 docs 里点开子文档,meet 的 URL 也变成
  // /docs/<id>,刷新/分享链接都能回到同一篇。
  //
  // 只用 replaceState 而不是 wouter 的 navigate:① 不该给浏览器历史堆一堆条目
  // (docs 自己已经管着前进后退);② navigate 会走 pushState,同样被 wouter 监听,
  // 与上面那条 docId effect 的守卫配合才不至于回声 —— 用 replaceState 语义更准。
  useEffect(() => {
    if (!docsOrigin) return
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== docsOrigin) return
      const data = e.data as { type?: string; docId?: unknown } | null
      if (data?.type === 'wemeet-open-search') {
        // docs 里点搜索 / 按 Ctrl+K —— 它的自带搜索已收敛,统一由这个面板承接,
        // 并预选「文档」标签。快捷键归谁由焦点在哪决定:人在 iframe 里打字时,
        // keydown 只到 iframe,外层监听不到,所以必须由 docs 转发过来。
        openGlobalSearch('docs')
        return
      }
      if (data?.type !== 'wemeet-route-changed') return
      // 只认 uuid;其余(列表页、回收站等)一律落回 /docs,不把 docs 的内部路径
      // 原样写进 meet 的地址栏。
      const id = typeof data.docId === 'string' && UUID_RE.test(data.docId) ? data.docId : null
      currentPathRef.current = id ? `/docs/${id}/` : '/'
      const shellPath = id ? `/docs/${id}` : '/docs'
      if (window.location.pathname !== shellPath) {
        window.history.replaceState(null, '', shellPath)
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [docsOrigin])

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
    if (!docsOrigin) return
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
  }, [docsOrigin])

  return (
    <Screen header footer={false}>
      {docsUrl && (
        // 内容区(Layout 的 <main>)是 flex 列;flex:1 + minHeight:0 让这一格铺满,
        // relative 则给进不去时的遮罩当定位参照(遮罩盖住 iframe 而不是替掉它 ——
        // 万一只是加载慢,底下那帧还能自己长出来)。
        <div
          className={css({
            position: 'relative',
            flex: 1,
            minHeight: 0,
            display: 'flex',
          })}
        >
          {bootstrapSrc && (
            <iframe
              ref={iframeRef}
              src={bootstrapSrc}
              title={t('nav.title')}
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
          {stalled && <DocsBlocked onRetry={retry} />}
        </div>
      )}
      {shareDoc && (
        <ShareToChatDialog
          body={buildDocCardBody({
            id: shareDoc.docId,
            title: shareDoc.title,
            url: shareDoc.url,
          })}
          contentType="doc-card"
          previewText={shareDoc.title || tIm('preview.doc')}
          errorMessage={tIm('docPicker.sendError')}
          // 分享即精准授权:给收到卡片的会话成员授只读(best-effort)。
          // 新建群转发时这里拿到的就是刚建出来的群 cid,同样授权。
          //
          // 授权是在 docs **之外**发生的,docs 的成员列表缓存无从知晓 —— 授完
          // 回发一条消息让分享弹窗刷新,否则用户回到「分享文档」框,「与 N 位
          // 用户分享」还是分享前的旧值。
          onSent={(cids) => {
            void grantDocAccess(shareDoc.docId, cids).then((granted) => {
              if (!granted || !docsOrigin) return
              iframeRef.current?.contentWindow?.postMessage(
                { type: 'wemeet-doc-access-updated', docId: shareDoc.docId },
                docsOrigin,
              )
            })
          }}
          onClose={() => setShareDoc(null)}
        />
      )}
    </Screen>
  )
}

/**
 * 云文档进不去时的兜底面板。
 *
 * 走到这里通常是:票据引导没成(Docs 未接 / 不可达)→ 退回 authenticate → 浏览器里
 * 没有 Keycloak 会话 → KC 登录页被自己的 `frame-ancestors 'self'` 挡在 iframe 外。
 * iframe 里的登录页是没救的(改 KC 的 CSP 等于给登录页开点击劫持),所以这里给的是
 * **顶层**重新登录 —— 走 meet 自己的 OIDC 入口,顺带把 KC 会话重新建起来,回来后
 * 云文档也就通了。
 */
const DocsBlocked = ({ onRetry }: { onRetry: () => void }) => {
  const { t } = useTranslation('docs')
  return (
    <div
      className={css({
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '1rem',
        padding: '2rem',
        textAlign: 'center',
        backgroundColor: 'greyscale.000',
        color: 'default.text',
      })}
    >
      <h2 className={css({ fontSize: '1.125rem', fontWeight: 'bold' })}>
        {t('blocked.title')}
      </h2>
      <p className={css({ color: 'greyscale.600', maxWidth: '28rem' })}>
        {t('blocked.description')}
      </p>
      <div className={css({ display: 'flex', gap: '0.5rem' })}>
        <Button
          variant="primary"
          onPress={() => {
            window.location.href = authUrl({ returnTo: window.location.href })
          }}
        >
          {t('blocked.login')}
        </Button>
        <Button variant="secondary" onPress={onRetry}>
          {t('blocked.retry')}
        </Button>
      </div>
    </div>
  )
}
