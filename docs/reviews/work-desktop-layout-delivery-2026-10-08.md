# 桌面 Work 布局重构建（2026-10-08）

Windows x64 内部安装包 **0.4.0-delivery.5** 已在本机重新构建，包含已发布网页的目标输入器、导航下半部分的任务历史以及窄屏历史选择修复。桌面使用内置 renderer，因此本次重打包才使这些布局进入桌面安装包；此前生产网页更新记录保持原验收范围。

| 交付信息                  | 值                                                                 |
| ------------------------- | ------------------------------------------------------------------ |
| 固定源码                  | `8bad7b050ded292bb1449a4f16fd858677cef1eb`，构建时工作树干净       |
| 安装包                    | `src/desktop/release/We-Meet-0.4.0-delivery.5-setup.exe`           |
| 大小                      | 187064133 bytes，约 187 MB                                         |
| SHA-256                   | `98d016d35fdfed849bbf824c300b89ebbbc69eae19e9a0dd2743176cb9c3549d` |
| Electron / builder        | 44.4.3 / 26.15.3                                                   |
| 内置本地运行环境          | 自有适配器 0.3.2，dsh 0.1.5rc1                                     |
| 运行环境 manifest SHA-256 | `6e7c9bc1f446d4ef2d11b8f8cd3bbdb55418e0ae9b11d5a8d90214d3ac18736f` |
| 默认业务 / IM             | `https://meet.we-meet.online` / `https://im.we-meet.online`        |
| Authenticode              | `NotSigned`，内部验收包                                            |

在 `src/desktop` 运行 `npm run package`：重新编译主进程、从当前源码构建前端、生成并校验来源记录、复制 renderer、验证独立运行环境，再由 NSIS 生成安装包与交付 manifest。本轮未重新构建或升级内置 dsh 运行环境。

固定源码的[发布 CI 37761228164](https://github.com/John-Shao/we-meet/actions/runs/37761228164) 已通过前端、后端、桌面及部署保护四项检查。

| 检查               | 结果                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| 桌面单元测试       | 32 项通过，1 项显式开启的原生测试跳过，0 失败                                                                                |
| 实际安装包解包审计 | SHA-256、ASAR、201 个编译文件和 186 个 renderer 资源全部与本次构建匹配                                                       |
| 内置原生适配器     | 从实际 NSIS 解出的载荷完成 capabilities、合成目录 grant、list 探测；ready、dsh、本地执行身份正确                             |
| Electron Work 集成 | 17 项检查通过；新目标输入器及下半部分历史可见，未残留主内容区历史列                                                          |
| 工作流程回归       | 真实 preload/IPC/协调器配合合成 API 与原生传输，验证授权、状态回报、手动同步、独立复核同意、未知响应重试、撤销权限及退出账号 |
| 供应商调用         | 0                                                                                                                            |

Work 集成测试更新了旧的页面标题断言，并加入任务历史必须位于工作导航中的检查。原生测试使用合成模型 key，只探测包内执行器，不提交真实模型任务。集成测试使用开发 Electron 加载本次内置 renderer；实际 NSIS 包内文件另经解包逐项校验。这些验证未覆盖实际安装替换、干净 Windows VM、正式登录、人工操作原生选择器或真实 dsh/Pi 模型执行。

本地交付 manifest 位于 `src/desktop/release/We-Meet-0.4.0-delivery.5-manifest.json`；解包回执位于 `src/desktop/test-results/installer-0.4.0-delivery.5.json`，Work 集成回执位于 `src/desktop/test-results/work-review/receipt.json`。脱敏交付证据见[机器回执](work-desktop-layout-delivery-2026-10-08.json)。

用户退出桌面程序后，在与现有客户端相同的安装范围运行新的 `setup.exe`；本轮没有自动安装、启动或替换用户当前客户端。旧 delivery.4 安装包继续保留在本机 `release/`，可供回退使用。新包没有正式 Windows 签名证书，也没有自动更新 feed。
