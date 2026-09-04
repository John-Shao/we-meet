# WeMeet Component System

> 状态：v1 基线。组件系统在 Color、Typography、Spacing、Shape、Elevation 之上，统一控件尺寸、状态与跨端行为；视觉值可以按平台密度映射，但语义和状态覆盖必须一致。

## 1. 机器可读尺寸契约

机器可读真源是 [`component.tokens.json`](../src/design-tokens/component.tokens.json)：

| 语义                               |        Web |                Android | 用途                        |
| ---------------------------------- | ---------: | ---------------------: | --------------------------- |
| `controlHeight.compact`            |       32px |             仅紧凑场景 | 表格、筛选、紧凑表单        |
| `controlHeight.default`            |       40px | 视觉控件可采用 M3 默认 | 普通按钮与独立操作          |
| `controlHeight.large`              |       48px |      48dp 最小交互目标 | 强调操作、触控场景          |
| `icon.small/medium/large`          | 16/20/24px |             16/20/24dp | 控件与导航 glyph            |
| `iconButton.compact/default/large` | 24/28/32px | 外层保持至少 48dp 热区 | Web 紧凑图标按钮盒          |
| `selectionControl.compact/default` |    18/22px |       使用 M3 原生控件 | Checkbox / Radio 可见指示器 |

Android 的主按钮高度保留 52dp，这是平台触控密度映射，不要求与 Web 逐像素相同。跨端需要一致的是 `compact / default / large` 的层级关系与用途。

## 2. 状态矩阵

所有可交互组件至少覆盖以下状态：

| 状态            | Button             | Input / Select   | Checkbox / Radio / Switch | Tabs     |
| --------------- | ------------------ | ---------------- | ------------------------- | -------- |
| default         | 必须               | 必须             | 必须                      | 必须     |
| hover           | Web 必须           | Web 必须         | Web 必须                  | Web 必须 |
| pressed         | 必须               | Select 必须      | 必须                      | 必须     |
| focus-visible   | 必须               | 必须             | 必须                      | 必须     |
| selected        | Toggle 必须        | Select item 必须 | 必须                      | 必须     |
| disabled        | 必须               | 必须             | 必须                      | 必须     |
| loading         | 提交动作必须       | 异步选择按需     | 不适用                    | 按需     |
| invalid / error | 危险动作与提交错误 | 必须             | 表单校验时必须            | 按需     |
| success         | 完成反馈按需       | 校验通过按需     | 按需                      | 不适用   |

状态颜色必须来自 `color.tokens.json` 的 `action / border / status / text / icon` 角色；焦点环不能只靠颜色变化，disabled 不能仅降低透明度后仍保持可点击。

## 3. Web 接入

- Panda 直接消费组件尺寸契约，规范名称位于 `sizes.controlHeight.*`、`sizes.icon.*`、`sizes.iconButton.*` 与 `sizes.selectionControl.*`；
- Input、TextArea、Select 使用 compact 控件高度并共享 hover、focus、invalid、disabled 语义；
- Button 统一 default、hover、pressed、focus、disabled、loading，loading 同时设置 `aria-busy` 并阻止重复提交；
- Checkbox、Radio、Switch、Tabs 共享 hover、pressed、focus、selected、disabled 状态；
- 原生 select 作为存量兼容入口，外观与 React Aria Select 使用同一尺寸和语义颜色。

## 4. Android 接入

- `Dimens.ControlCompact/Default/Large` 映射共享控件高度；
- `Dimens.MinTouchTarget` 映射 large 档，功能性热区不得小于 48dp；
- `PrimaryButton / SecondaryButton / DangerButton` 继续由共享组件提供 enabled/loading/危险语义；
- hover 不适用于触控端；pressed、focused、selected、disabled 使用 Material 3 状态层与语义颜色。

## 5. 迁移规则

1. 新业务代码优先使用 primitives / `core-design` 共享组件，不手写同款控件；
2. 修改存量页面时同步移除局部高度、圆角、焦点环和状态色；
3. 图标的 glyph 大小与点击热区分开定义，不能为了缩小图标而缩小热区；
4. 迁移以视觉无回归为前提，尺寸命名切换不应改变现有盒高；
5. Web 运行 `npm run check:foundations`，Android 运行 `FoundationTokensTest` 与 `checkDesignTokens`。
