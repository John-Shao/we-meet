# Qwen-Live-Harness 介绍配图

| 文件 | 来源与用途 |
| --- | --- |
| `official-overview.png` | 官方中文 README 引用的模型与工具关系示意图，下载于 2026-10-13；保留原图，非产品界面截图 |
| `intro-architecture.mmd`／`.png` | 为介绍编写的简化组件图，说明本机 Host、daemon 与云端模型、可选后台执行器的关系 |
| `intro-coding-flow.mmd`／`.png` | 对话式编程的示例流程，非实际运行验收记录；追加指令取决于后台能力 |
| `overall-architecture.svg`／`.png` | 总体架构图，标明用户、本地设备、Harness 内部组件、独立后台执行器和云端模型的边界 |

官方图片来源：https://qianwen-res.oss-cn-beijing.aliyuncs.com/Qwen3.8-Omni-Flash/fig3.png

官方说明：[固定版本中文 README](https://github.com/QwenLM/Qwen-Live-Harness/blob/b6ce544ebbcd7417e37e0314ec946466c49c615c/README_ZH.md)。官方图片归原作者所有，保留来源说明；模型图中的概念不能逐项视为 Host 或 daemon 的本地组件。

自绘图使用 Mermaid 或 SVG 源文件生成 PNG；修改图时同步更新对应源文件与图片。
