# 第十二批：上传原文件下载与 Android 改名入口

上传件的所有者在“录音信息”中可下载原文件。download_media 按上传来源、所有者、全文权限和保留媒体状态真实返回；全文分享不附送媒体下载权限。原生录音目前是分片及缺口清单，未将它误当作一个可下载原文件；本批不支持拼接导出。

复用 `media/?download=true` 的签名 GET，额外签入附件 Content-Disposition，保留播放 GET 的原语义。文件名去除目录、控制字符并限制长度，中文使用标准 UTF-8 文件名参数。Web 先取得新签名再让浏览器流式下载，20 秒准备超时可重试，不把大文件载入 JS 内存；卸载后晚到的签名不会启动下载。Android 在前后复核 record revision 和独立 download_media 权限，再交给系统浏览器处理，界面提示查看浏览器下载进度，不伪报已下载完成。

补查发现 Android 的改名 repository 已允许上传件，但按钮仍限制原生录音。本批移除这一残留条件，继续使用 expected_title 守卫。

验证：后端 8 项、Web 19 项、Android media repository 10 项通过；Pixel 8 / Android 16 模拟器新增上传件改名测试 1 项通过，同时编译全部 Android 测试源集。TypeScript、ESLint 通过。Ruff 除 uploaded_recordings.py 原有 3 个 PLR0913 参数数目项外通过，未将这些旧签名作为本批改造范围。

未执行真实对象存储传输、系统浏览器下载完成验收或原生分片拼接。签名链接已下载到用户设备的文件不属于服务端撤权可回收的范围。无需数据库迁移。
