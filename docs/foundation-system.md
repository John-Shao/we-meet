# WeMeet Typography & Spacing System

> Shape 与 Elevation 见 [Shape & Elevation System](./shape-elevation-system.md)。

> 状态：v1 基线。Typography 与 Spacing 是跨 Web、Android、Figma 的共享语义契约；
> 平台实现保持各自原生观感，不追求逐像素复制。

## 1. 规范基线

1. [Material 3 Typography](https://developer.android.com/develop/ui/compose/designsystems/material3)：
   采用 display、headline、title、body、label 五类、每类 large/medium/small 的 15 档字阶；
2. [DTCG Format 2025.10](https://www.designtokens.org/tr/2025.10/format/)：
   使用 `dimension`、`fontFamily` 与 `typography` composite 表达跨工具契约；
3. [WCAG 2.2 Resize Text](https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html)：
   Web 在 200% 文字缩放下不得丢失内容或功能；
4. [WCAG 2.2 Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)：
   普通内容在等效 320 CSS px 宽度下不得依赖双向滚动。

Spacing 采用 WeMeet 的跨端工程约定：4px/dp 是基础单位，8px/dp 是主要排版节奏；
2px/dp 仅用于紧凑图标—文字间距或精细光学修正。这里是产品规范，不冒充 WCAG 条款。

## 2. 机器可读契约

- [`spacing.tokens.json`](../src/design-tokens/spacing.tokens.json)：
  `0 / 2 / 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64`；
- [`typography.tokens.json`](../src/design-tokens/typography.tokens.json)：Material 3 的 15 档
  字号、行高、字重与字距；
- Web：Panda 将尺寸换算为 `rem`，避免阻止浏览器文字缩放；
- Android：DTCG `px` 按逻辑尺寸 1:1 映射到 `dp`，字体尺寸映射到 `sp`；
- 字体族是平台映射：Web 使用 system-ui fallback，Android 使用系统 Roboto/Noto CJK。

## 3. Typography 使用规则

| 角色            | Size / line-height | 典型用途                   |
| --------------- | -----------------: | -------------------------- |
| `headlineSmall` |            24 / 32 | 页面主标题、任务详情标题   |
| `titleLarge`    |            22 / 28 | TopAppBar、重要内容标题    |
| `titleMedium`   |            16 / 24 | 面板、卡片、列表主标题     |
| `titleSmall`    |            14 / 20 | 强调型分组标题             |
| `bodyLarge`     |            16 / 24 | 主要正文                   |
| `bodyMedium`    |            14 / 20 | 默认正文、表单、次要信息   |
| `bodySmall`     |            12 / 16 | 时间戳、辅助说明、密集列表 |
| `labelLarge`    |            14 / 20 | 常规按钮、字段标签         |
| `labelMedium`   |            12 / 16 | Badge、Chip、紧凑按钮      |
| `labelSmall`    |            11 / 16 | 空间受限的最小标签         |

- 业务代码选择语义 style，不单独组合 `fontSize + lineHeight + fontWeight`；
- 板块标题与正文的层级优先用 style、字重和间距表达，不依赖新增颜色；
- 11px/sp 是新界面最小标签档，10/9sp 只保留给 Android 日历网格等已记录例外；
- 中文正文不使用 Light/Thin 字重；默认正文 Regular，标签 Medium，关键标题再使用 Bold；
- 固定高度控件必须在 200% 字体缩放下验证，不允许裁切文字。

## 4. Spacing 使用规则

| Token | Value | 用途                           |
| ----- | ----: | ------------------------------ |
| `xxs` |     2 | 光学修正、极紧凑内部间距       |
| `xs`  |     4 | 图标内部、紧凑列表             |
| `sm`  |     8 | 默认 inline/stack gap          |
| `md`  |    12 | 相关控件组、紧凑卡片           |
| `lg`  |    16 | 页面边距、卡片内边距           |
| `xl`  |    24 | 板块间距、面板内边距           |
| `2xl` |    32 | 大分区间距                     |
| `3xl` |    48 | 空状态、整屏留白               |
| `4xl` |    64 | 超大版面分区；普通组件不得使用 |

优先顺序：语义 alias（如 `spacing.stack.section`）→ `space.*` 基础刻度 → 有说明的组件几何例外。
视频舞台、日历时间网格和拖拽手柄等由内容决定的几何尺寸，不强行套排版栅格。

## 5. 当前迁移状态

- Web Panda 已直接消费 Typography、Spacing、Shape、Elevation、Component 五份 DTCG 契约；
- Web Input、TextArea、Select、Field、Chip、Badge、Button 以及任务详情核心区域已开始使用
  Material 语义字阶和命名间距；
- Android `JusiTypography` 已显式映射全部 15 档，`Dimens.Space*` 已与共享间距阶梯对齐；
- Android 任务详情原本已经使用 `MaterialTheme.typography` 与 `Dimens`，无需逐项重写；
- 存量页面按业务域渐进迁移，不做一次性全站字号替换。

## 6. 自动校验

Web：

```bash
cd src/frontend
npm run check:foundations
```

校验 DTCG schema、10 档 spacing、15 档 Material 3 type scale、7 档圆角、6 档高程、
组件尺寸、明暗复合阴影、语义引用与 Panda 接入，以及已迁移 primitives 不重新引入裸值。该命令已接入前端 CI。

Android：

```bash
./gradlew :core-design:testDebugUnitTest checkDesignTokens
```

`FoundationTokensTest` 锁定 Android 的 spacing、typography、shape 与 elevation 映射；`checkDesignTokens` 继续阻止
新增裸 `.dp`、`.sp`。
