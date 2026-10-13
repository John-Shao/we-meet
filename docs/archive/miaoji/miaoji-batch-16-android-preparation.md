# 第十六批：Android 异步准备阶段播放失败

2026-09-20，按用户选择使用 Pixel 8 / Android 16 模拟器，通过 ADB 和 UI Automator 操作真实 App，连接生产环境。Android 起始版本 `e1ebc39e`，修复提交 `cd3b23dd`；服务端仍为 revision 373。

## 复现与修复

通过 App 登录演示账号，打开验收视频 `f5387755-a083-47d7-9c60-5e9065203d9a`，点击播放立即出现播放失败。日志为 MediaPlayer `-38/0`。UI 在 `prepareAsync()` 后立即读取 duration，原封装只用 `runCatching`；底层通过异步错误回调进入错误态，异常捕获不能保护播放器。

时长和播放状态现在只在 prepared 后读取；关闭时直接 reset/release，不再在准备阶段查询播放状态。状态依据见 [Android MediaPlayer 文档](https://developer.android.com/reference/android/media/MediaPlayer)。

## 验证

- 真实 WAV 回归测试加入与页面相同的调用顺序，修复前稳定失败：`media playback failed: -38/0`。
- 修复后 Pixel 8 上全部 8 项 `UploadMediaPlayerTest` 通过，包含真实异步准备、媒体时钟、定位及 Surface 连接。构建与设计 token 提交检查通过。
- 安装修复版 App，重新通过真实登录页面进入生产账号。同一视频显示 `0:47` 时长，真实画面出现，进度到 `0:10`，原文高亮从首段切换到 `0:06` 段。播放阻断关闭；头部/控制区布局不计为通过。
- 本批仅 Android 代码更新，不要求重新部署后端或 Web。模拟器安装的是本地 debug APK，不代表正式 Android 包已发布。

## 自动进入下一批

真实画面暴露两个问题：竖屏 Surface 画面溢出并覆盖控制区；英文导出按钮被压窄到断字。下一批修复布局后继续 App 导入、播放、纪要及下载验收。此次没有验证实际音质、长录音跨页、大文件分片恢复、签名过期续期或其他身份撤权。
