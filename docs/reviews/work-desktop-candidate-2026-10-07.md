# Windows 桌面内部候选包（2026-10-07）

接续 `0a59b1baa` 的复核窗口验收，本批将最新桌面页面交付为 `0.4.0-delivery.2`。构建源码为干净提交 `49f374e20c008ab2b01845c80e9d0b924615a001`，没有修改生产配置、调用付费模型或替换已安装客户端。

## 交付身份

| 项目 | 值 |
| --- | --- |
| 内部安装包 | `src/desktop/release/We-Meet-0.4.0-delivery.2-setup.exe` |
| 大小 | 187042191 字节 |
| SHA-256 | `9e35e476258436de657ddb278a18ddb3f781deb6e79a5c18762a0cc0fa29183e` |
| Authenticode | `NotSigned`，内部验收用途 |
| 内置 Agent / dsh | `0.3.1` / `0.1.5rc1`，运行环境独立于桌面版本 |
| Electron / builder | `44.4.3` / `26.15.3` |
| 包内 app.asar SHA-256 | `5227ad13a6acafd9bfcaf1bdb01387ded9c12ce1fe89ef7bfc482030cc7ff26f` |

安装包包含成果显式同步后的 Pi 复核入口、独立发送授权、复核状态/意见/用量，以及权限查询失败时隐藏缓存的修复。它保留当前产品的正式服务地址，但复核能否使用仍取决于服务端开关和部署；本轮没有启用生产 reviewer。

旧 `0.4.0-delivery.1` 安装包保留，SHA-256 仍为 `a6aa971ab93dedb215843000b46a881801e2d2a98bd59c6d4bf815626caa36a0`。构建输出目录中的 `win-unpacked` 对应新版本，不代表旧包的展开目录。

## 打包来源与验收

此前 `package:prepared` 可沿用旧 renderer，仅检查 Agent 运行环境。本批构建记录源码、依赖锁、Vite 环境和构建配置的输入哈希，以及生产资源输出哈希；复制与打包前重新校验，生成清单时核对实际 `app.asar`。新增/修改源码、配置或依赖变化、资源缺失/篡改/新增、旧构建记录均会拒绝打包并要求重建。`.env` 内容及进程 Vite 值只参与内部哈希，不写入明文交付记录。

桌面回归 29 项通过、1 项原生适配器 opt-in 跳过，新增来源校验 8 项均通过。重新构建并复制后的真实 Electron 复核窗口 16 项检查通过，使用合成登录/API/执行器，不产生模型费用。前端生产构建、桌面编译、运行环境清单与脚本语法检查通过；已有品牌静态资源与大 chunk 构建提示保留。

另从实际 NSIS 文件解包，逐字核对 201 个 `dist` 文件，包含主进程、preload、协调器及 renderer；186 个生产页面资源的包内身份与清单一致。完整内置运行环境通过 ManagedRuntime 清单及逐文件哈希校验。直接启动解包的真实 `work-agent-local.exe`，使用合成密钥只请求 capabilities、中文目录 grant 和空任务 list，均通过。此项补充包内原生探测，不能把前述默认 opt-in 跳过写成已运行。

临时解包目录、原生进程和工作空间已清理。脱敏证据保存在 [交付 JSON](work-desktop-candidate-2026-10-07.json)，本机原始回执为 `src/desktop/test-results/installer-0.4.0-delivery.2.json`。验收脚本为 `src/desktop/scripts/verify-installer.mjs`，需通过 `WEMEET_7ZA` 指定本机 7za；只解包与探测，不安装或登录产品。

## 待验范围

本轮未进行原产品安装/升级/回退、真实 OIDC 登录、人工原生选择器或干净 Windows VM 验收。此前隔离衍生包的安装记录见 [联合验收](work-cross-device-acceptance-2026-10-07.md)，不能替代新原产品候选包的实际安装验收。

没有 Windows 代码签名证书及产品运行时更新信任根，正式发布与签名升级仍关闭。下一批集群联调等待测试 context/namespace、专用 Docker 节点、镜像仓库和 TLS Secret；没有将生产集群视为测试环境。
