# 文档目录导航

本索引只做导航，不复制任何状态、计数或进展。
**Work 模块先读 [work/README.md](work/README.md)**（入口与权威来源表）；当前状态以 [work/status.json](work/status.json) 为机器可读来源。
plan 目录的内部阅读顺序见 [plan/README.md](plan/README.md)。

## 子目录

| 目录 | 内容 |
|---|---|
| [adr/](adr/) | 架构决策记录（ADR，按编号递增） |
| [apis/](apis/) | 对外接口文档（App 端 AI 打电话、移动端 API） |
| [assets/](assets/) | 文档引用的截图与图片资产 |
| [deployment/](deployment/) | 部署交接与验收记录 |
| [design-system/](design-system/) | 设计系统规范：Color / Component / Foundation / Shape & Elevation / Theming；机器可读真源在 `src/design-tokens/` |
| [examples/](examples/) | 部署示例（compose / helm / livekit） |
| [extensions/](extensions/) | 扩展功能设计（一对一通话、会议室、日历同步、企业套件等） |
| [features/](features/) | 功能文档（大模型接入、AI 助手、认证、转写等） |
| [installation/](installation/) | 安装与本地开发指南（自带 [README](installation/README.md)；本项目统一走 Tilt） |
| [phases/](phases/) | 阶段方案（p11b 等） |
| [plan/](plan/) | 方案与执行记录（自带 [README](plan/README.md)；Work 已迁至 [work/](work/README.md)） |
| [research/](research/) | 调研、竞品分析与评测 |
| [reviews/](reviews/) | UX 与技术审查记录（md 与同名 json 配对） |
| [work/](work/README.md) | Work 模块文档入口：六份短文档＋活设计（design/）＋历史归档（archive/）＋状态（status.json） |

## 根目录文件

| 文件 | 内容 |
|---|---|
| [developping_locally.md](developping_locally.md) | 本地开发指南（上游沿用文件名；Windows/Tilt 补充见 [installation/local-dev-tilt-windows-cn.md](installation/local-dev-tilt-windows-cn.md)） |
| [openapi.yaml](openapi.yaml) | Meet External API 契约（OpenAPI 3.0.3） |
| [resource_server.yaml](resource_server.yaml) | OAuth resource server 契约 |
| [reservation-lifecycle.md](reservation-lifecycle.md) | 预约视频房间的生命周期与过期规则 |

## 约定

- UI 改动必须遵循 [Component System](design-system/component-system.md)（见 [CONTRIBUTING](../CONTRIBUTING.md)）。
- 带日期的 review/research 文档是历史记录：其中的路径与结论保持当时语义，目录调整以文内带日期标注为准。