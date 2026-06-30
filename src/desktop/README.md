# we-meet 桌面端（Electron）

we-meet 的 Windows / macOS 桌面客户端。**外壳薄、UI 不重写**——renderer 直接复用
`src/frontend` 的 React 应用（`livekit-client` 在 Electron 捆绑的 Chromium 里原生可用，
媒体行为与 Web 一致）。选型理由见 [`docs/extensions/客户端多端策略_对标飞书.md`](../../docs/extensions/客户端多端策略_对标飞书.md)。

## 结构

```
src/desktop/
  src/main.ts        Electron 主进程：建窗口、加载 renderer、外链走系统浏览器
  src/preload.ts     contextBridge 安全桥（window.weMeetDesktop）
  scripts/           构建辅助（copy-renderer：frontend/dist → dist/renderer）
  electron-builder.yml  打包配置（win nsis / mac dmg）
  .npmrc             Electron 二进制走 npmmirror 国内镜像
```

主进程/preload 用 TS（CommonJS）→ `dist/`；renderer = 现有 React 前端，不在此重写。

## 开发（本地启动）

需要两个终端：

```bash
# 终端 1：前端 dev server（端口 3000，见 src/frontend/vite.config.ts）
cd src/frontend && npm run dev

# 终端 2：桌面外壳（编译 main/preload 后启动 Electron，加载 localhost:3000）
cd src/desktop && npm install && npm run dev
```

Electron 窗口即显示 we-meet React 应用。改 `WEMEET_RENDERER_URL` 可指向别的地址
（如 `https://meet.we-meet.online` 直接套生产 Web）。

## 当前进度（first cut）

✅ **已完成**：外壳脚手架 + dev 本地启动（加载现有 React）+ 外链走系统浏览器 +
contextBridge 安全基线（contextIsolation / 无 nodeIntegration / sandbox）。

🔜 **下一步（按顺序）**：
1. **OIDC 系统浏览器 + PKCE**：登录走系统浏览器 / 自定义 scheme（`wemeet://`）回跳，
   禁内嵌 webview 登录（Keycloak 安全要求）。dev 内嵌回跳可临时用，prod 必须改。
2. **桌面能力**：系统托盘、原生通知、开机自启、全局快捷键、会议独立窗口。
3. **屏幕共享**：`desktopCapturer` 接 LiveKit。
4. **prod 打包**：`npm run package`（win nsis / mac dmg）。⚠️ 已知前置——Electron prod 走
   `file://`，前端默认绝对资源路径（`/assets`）会解析失败，需 **前端以相对 base 构建
   （`vite base: "./"`）或自定义 `app://` 协议**；再加代码签名（win EV / mac notarize）。
5. **自动更新**：`electron-updater` + 自建/对象存储 feed。

> macOS 产物需在 macOS 或 CI 上打；Windows 可本地打 nsis。
