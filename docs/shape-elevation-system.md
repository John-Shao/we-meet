# WeMeet Shape & Elevation System

> 状态：v1 基线。Shape 与 Elevation 是 Web、Android、Figma 共用的语义契约；各平台保留原生渲染方式，不要求阴影逐像素相同。

## 1. 规范基线

1. [Material 3 Compose theming](https://developer.android.com/develop/ui/compose/designsystems/material3)：Shape 是 `MaterialTheme` 的基础子系统，采用 extraSmall 至 extraLarge 的五档规模；
2. [Material 3 Shapes API](https://developer.android.com/reference/kotlin/androidx/compose/material3/Shapes)：组件从主题读取形状，不在业务层重复写圆角；
3. [DTCG Format 2025.10](https://www.designtokens.org/tr/2025.10/format/)：跨工具契约使用 `dimension` 与 `shadow` 类型，复合阴影使用 layer 数组表达。

## 2. Shape scale

机器可读真源是 [`shape.tokens.json`](../src/design-tokens/shape.tokens.json)。DTCG 的 1px 在 Android 映射为 1dp；Web 的有限圆角由 Panda 转成 rem。

| Scale        | Value | Semantic alias | 典型用途                          |
| ------------ | ----: | -------------- | --------------------------------- |
| `none`       |     0 | —              | 拼接按钮中段、直角区域            |
| `extraSmall` |     4 | `field`        | Input、TextArea、Checkbox、菜单项 |
| `small`      |     8 | `control`      | Button、Select、Badge、紧凑浮层   |
| `medium`     |    12 | `card`         | 卡片、内容容器                    |
| `large`      |    16 | `panel`        | 侧面板、Bottom Sheet              |
| `extraLarge` |    24 | `modal`        | Dialog、重点模态容器              |
| `full`       |  9999 | `pill`         | Chip、Switch、圆形按钮、进度条    |

业务代码优先使用 `field / control / card / panel / modal / pill`，不要根据“看起来差不多”选择数字。圆形和胶囊共用 `pill`；元素本身的宽高决定最终轮廓。

## 3. Elevation scale

机器可读真源是 [`elevation.tokens.json`](../src/design-tokens/elevation.tokens.json)。

| Token     | Native level | Web shadow        | 典型用途                   |
| --------- | -----------: | ----------------- | -------------------------- |
| `flat`    |          0dp | 无                | 普通内容                   |
| `subtle`  |          1dp | 轻微投影          | 控件滑块、轻抬升卡片       |
| `raised`  |          3dp | 小范围投影        | Tooltip、悬浮控件          |
| `overlay` |          6dp | 描边 + 中等投影   | Menu、Popover、Select 浮层 |
| `sticky`  |          8dp | 定向投影          | 吸顶/吸底栏                |
| `modal`   |         12dp | 描边 + 大范围投影 | Dialog、Modal              |

Elevation 表达的是层级，不是装饰。边框、焦点环、选中内描边、拖拽指示线不属于 elevation，仍使用对应的语义 border/focus 状态。深色主题的阴影带浅色内描边，用于维持深色 surface 之间的边界。

## 4. 平台接入

- Web：Panda 从两份 DTCG 文件生成 radii 与 light/dark semantic shadows；组件使用 `borderRadius: 'control'`、`boxShadow: 'overlay'` 等名称。
- Android：`JusiShapes` 注入 `MaterialTheme.shapes`；高程使用 `Dimens.Elevation*`。业务层不得把 `Dimens.Space*` 当作 shape 或 elevation。
- Figma：Radius Variables 与 Effect Styles 使用相同名称。语义变量指向基础 scale，避免组件保存孤立数值。

## 5. 自动校验

```bash
cd src/frontend
npm run check:foundations
```

该命令校验 DTCG schema、7 档圆角、6 档高程、明暗两套复合阴影、Panda 接入，以及首批迁移组件不重新引入裸圆角/裸 elevation shadow。

Android：

```bash
./gradlew :core-design:testDebugUnitTest checkDesignTokens
```

`FoundationTokensTest` 锁定 Compose 的 Shape 与 Elevation 映射；`checkDesignTokens` 继续阻止业务代码新增未归档的尺寸字面量。
