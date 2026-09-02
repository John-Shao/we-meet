# WeMeet Color System

> Typography 与 Spacing 见 [Foundation System](./foundation-system.md)。

> 状态：v1 基线。先建立跨端语义契约与自动校验，再按页面逐步迁移；本阶段不做全站换色。

## 1. 目标与边界

WeMeet 的颜色不是一组可随意取用的 HEX，而是一套跨 Web、Android 和后续 iOS/Figma
共享的语义契约。Color System 需要同时保证：

- 同一语义在各端一致，例如 `danger` 永远表示破坏性或高风险结果；
- Light、Dark 及后续 High Contrast 模式均有明确映射；
- 文字、图标、控件边界和焦点状态满足无障碍要求；
- 业务组件依赖语义角色，不依赖某个具体蓝色或灰色色阶；
- 调整品牌或主题时，只修改 token 映射，不逐页搜索替换。

用户自选颜色（日历颜色、头像哈希色、服务端下发颜色）不属于固定主题色板，但其承载的
文字、焦点与状态仍必须使用可预测的语义前景色，不允许把用户颜色直接当文字色。

## 2. 规范基线

上线验收采用以下优先级：

1. [WCAG 2.2 AA](https://www.w3.org/TR/WCAG22/)：当前强制质量底线；
2. [GB/T 37668-2019](https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=35ECC696805C1A67C93B74FB6D0D8EFB)：国内互联网内容无障碍现行推荐性国标；
3. [Material 3 Color System](https://developer.android.com/develop/ui/compose/designsystems/material3)：Android 角色映射；
4. [Apple HIG Color](https://developer.apple.com/design/human-interface-guidelines/color)：Apple 平台适配原则；
5. [DTCG 2025.10](https://www.designtokens.org/tr/2025.10/color/)：跨工具 token 交换格式。

WCAG 3/APCA 仍可用于研究和辅助评估，但当前不替代 WCAG 2.2 的发布门槛。

### 2.1 对比度门槛

| 对象                              | 最低对比度 | 本系统规则                           |
| --------------------------------- | ---------: | ------------------------------------ |
| 普通文字、辅助文字、链接          |      4.5:1 | 强制                                 |
| 大号文字                          |        3:1 | 允许，但不作为缩小普通文字门槛的手段 |
| 功能图标、控件边界、选中/焦点状态 |        3:1 | 强制                                 |
| AAA 普通文字                      |        7:1 | 阅读密集或关键页面推荐               |
| Disabled                          |  WCAG 豁免 | 仍须可辨识，但不纳入硬门槛           |

颜色不得成为传达错误、成功、选中、日历归属等信息的唯一方式；必须同时使用文字、图标、
形状、描边或位置中的至少一种非颜色线索。

## 3. Token 架构

### 3.1 Reference / Palette

`color.palette.*` 是稳定的原始色值，只允许主题层和少数算法型场景引用。业务页面不得直接
引用 `brand.500`、`neutral.300` 等数字档。

### 3.2 Semantic

`color.semantic.{mode}.*` 是组件和业务代码的公共 API：

```text
surface.canvas/default/raised
text.primary/secondary/disabled/inverse/link
icon.primary/secondary/disabled
border.subtle/default/strong/focus
action.primary.background/foreground/hover/pressed
action.selected.container/on-container
status.{danger|warning|success}.default/on-default/container/on-container
```

`default/on-default` 与 `container/on-container` 必须成对使用。禁止从另一组借前景色，也禁止
拿 `border.*` 或 `surface.*` 当文字色。

### 3.3 Component

只有通用语义无法表达组件意图时才增加组件 token，例如视频画面上的恒深色控件、日历冲突
标记。命名必须描述用途，不描述外观：

```text
room.overlay.scrimStrong     # 正确：描述用途
room.black80                 # 错误：描述当前实现
calendar.conflict            # 正确：不同于 destructive danger
```

## 4. 品牌色与操作色

首批契约刻意拆开两个容易混用的蓝色角色：

- `brand.500 = #3370FF`：品牌表达、焦点环、图标强调；在白底上达到非文本 3:1；
- `action.primary.background = #2860D9`：实心主按钮底；与白色按钮文字达到正文 4.5:1。

因此不能把 `brand.500 + white` 当普通字号的按钮文字组合。链接使用更深的 `brand.700`，
Dark Mode 则映射到更亮的前景蓝。

## 5. 模式与平台映射

模式是 token 的值域，不进入组件命名。组件只请求 `text.secondary`，由主题决定它在 Light、
Dark 或 High Contrast 下的实际值。

| 跨端语义            | Android                               | Web                                 |
| ------------------- | ------------------------------------- | ----------------------------------- |
| `surface.canvas`    | `background` / 页面扩展 canvas        | Panda semantic token / CSS variable |
| `surface.default`   | `surface`                             | 面板、卡片背景                      |
| `text.primary`      | `onSurface`                           | 主文字                              |
| `text.secondary`    | `onSurfaceVariant`                    | 次要文字                            |
| `action.primary.*`  | `primary/onPrimary`                   | 主按钮专用角色                      |
| `action.selected.*` | `primaryContainer/onPrimaryContainer` | 选中行、选中 chip                   |
| `border.focus`      | focus ring token                      | 全站统一 focus outline              |
| `status.*`          | `WeMeetTheme.extras.status`           | Panda status semantic token         |

各平台可以保留符合平台观感的 surface 层次，但品牌、状态含义与可访问性结果必须一致。
Dark Mode 是独立映射，不是颜色反转；半透明色必须按合成后的实际背景计算。

## 6. 机器可读契约与校验

规范源位于 [`src/design-tokens/color.tokens.json`](../src/design-tokens/color.tokens.json)，采用
DTCG 2025.10 的 opaque sRGB 表达，并保留 HEX fallback。sRGB 是首期跨设备基线；未来可以在
兼容链路稳定后增加 OKLCH/P3 增强值，不能牺牲 sRGB fallback。

Web 本地校验：

```bash
cd src/frontend
npm run check:colors
```

校验器会检查：

- DTCG schema 版本；
- token 引用缺失或循环；
- sRGB component、alpha 与 HEX fallback 一致性；
- Light/Dark 下 44 组核心文字、图标、边界、焦点、按钮和状态色配对。

该命令已接入前端 CI。任何低于门槛的配对必须修改颜色或语义关系，不允许四舍五入通过，
也不允许删除测试配对绕过。

## 7. 当前现状与迁移策略

### Android

- `core-design` 已集中持有完整的 M3 `ColorScheme` 与 `WeMeetTheme.extras`；
- `checkDesignTokens` 已禁止新增裸 `Color(0x…)`，并限制错误的前景槽位；
- 已显式覆盖 secondary/tertiary/surfaceVariant、outline、error、inverse 与 surface container，
  Button、TextField、Chip、Badge、Snackbar 不再回落到 Material 默认紫色；
- 已为 `on-*`、状态容器、边界及关键业务色增加可执行的 Kotlin 对比度测试。

### Web

- Panda 已有 palette 与部分 semantic tokens，但 `primary` 同时承担品牌、链接、图标和按钮，职责过宽；
- 存量代码仍存在较多 HEX/RGB 字面量，先建立基线、禁止增量，再按组件迁移；
- 已新增 `surface/text/icon/border/action/status` 公共角色，并将 Button、Input、TextArea、
  Select、Chip、Badge、Toast、Checkbox、Radio、Switch、Tabs、Box、Menu、Popover 等
  primitives 迁移到这些角色；业务页面仍按阶段 D 逐步收口；
- `npm run check:colors` 除 WCAG 配对外，还会扫描已迁移的源文件，禁止重新引入
  `greyscale/primary/control/default` 等兼容颜色族；
- 会中舞台的 `primaryDark.*` 固定深色控件，以及视频内容上的半透明遮罩属于
  component/product 例外；它们不跟随 App Light/Dark 模式反转；
- 用户日历色、视频内容色和外部内容色单独建例外清单，不强行 token 化。

## 8. 变更流程

新增或修改颜色必须同时提交：

1. 语义说明与适用/禁用场景；
2. Light、Dark 成对值；
3. 所有实际前景—背景组合的对比度测试；
4. 关键组件 Light/Dark 截图或视觉回归；
5. 若跨端共享，更新 Android/Web 映射；
6. 若颜色按下标持久化（头像、机器人预设），提供兼容或迁移方案，不能调整顺序后直接上线。

## 9. 交付阶段

- **A — Foundation（已完成）**：DTCG 契约、规范、CI 对比度校验；
- **B — Core roles（已完成）**：App 补齐完整 M3 scheme；Web 新增公共 semantic roles；
- **C — Primitives（已完成）**：Button/Input/Select/Chip/Badge/Toast/Dialog 全量迁移；
- **D — Product colors（下一阶段）**：日历、IM、会议、审批、任务等业务色收口；
- **E — High Contrast & P3**：高对比主题和宽色域增强。

每阶段都必须可独立发布；不等待一次性全站迁移。
