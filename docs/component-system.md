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

### 图标按钮

- 纯图标操作统一使用 `IconButton`，可切换状态使用 `IconToggleButton`；业务代码不再自行拼装方形热区、悬停色和焦点环；
- 两个基元都强制提供 `label`，该值同时成为可访问名称和默认 Tooltip，图标本身应设置 `aria-hidden="true"`；
- 仅使用 `icon24 / icon28 / icon32` 三档：树行等紧凑区域用 24，表格和弹窗用 28，页面或面板工具栏用 32；
- 普通动作使用 `quaternaryText`，危险动作使用 `quaternaryDanger`，有开关语义的动作使用 `IconToggleButton` 和受控 `isSelected`。

### Chip 与页面分段切换

- 静态标签使用 `Chip`；可删除的筛选条件使用 `DismissibleChip`，由基元统一关闭图标、间距以及 hover、pressed、focus-visible、disabled 状态；
- `DismissibleChip.label` 必须描述动作，例如“移除筛选：高优先级”，不能只读作“高优先级”；
- 日历 / 会议室等同级页面模式使用 `SegmentedControl appearance="underline"`；搜索分类等紧凑筛选使用 `appearance="pill"`，不再由页面手写两套 Tab；
- `density="default"` 用于页面级视图切换，`density="compact"` 用于弹窗与紧凑筛选；两档均使用语义色和统一状态，不在调用点覆盖选中颜色；
- `SegmentedControl` 使用 tablist / tab 语义，并支持方向键以及 Home / End 键导航，页面代码只管理当前值。

### 操作菜单与浮层

- 业务操作菜单使用 `ActionMenuSurface / ActionMenuItem`，不再自行组合白底、灰边框、数字圆角与阴影；
- 菜单表面统一使用 `surface.default / border.default / radius.control / elevation.overlay`，因此自动适配明暗主题；
- 普通菜单项使用 `tone="neutral"`，删除、取消订阅等危险动作使用 `tone="danger"`；
- 菜单打开后聚焦首个可用动作，并支持方向键、Home / End 与 Escape；锚点定位和视口防溢出仍由具体场景负责；
- 单行 Dialog 标题栏统一使用 `ModalHeader`，由组件提供 `titleMedium` 字体、语义分隔线、文本截断和标准关闭动作；带副标题或返回按钮的复杂标题栏才保留场景化组合；
- Dialog 底部操作栏统一使用 `ModalFooter`：普通表单默认右对齐，人员选择等需要展示计数或状态时使用 `space-between`；组件统一提供语义分隔线和标准间距；
- Dialog 内容区统一使用 `ModalBody`：普通表单使用标准内边距，贴边列表显式设置 `padding="none"`；组件统一正文语义、滚动行为和 flex 收缩规则；
- 自定义 Dialog 标题栏的关闭动作仍必须使用 `ModalCloseButton`，不能使用无 hover、focus-visible 状态的裸 `×` 按钮。

### 可交互列表行与选择行

- 搜索结果、联系人候选和紧凑选择面板使用 `InteractiveListRow`，多选人员入口使用带固定选择指示器的 `SelectableListRow`；
- 列表行统一使用 `surface.canvas / action.selected / border / text` 语义角色，并覆盖 hover、pressed、focus-visible、selected 与 disabled；
- 普通选择按钮通过 `aria-pressed` 暴露状态；位于 `listbox` 中的行传入 `role="option"`，基元会改用 `aria-selected`，避免同时声明两套选择语义；
- `InteractiveList` 作为键盘导航边界，统一支持 ArrowUp / ArrowDown 与 Home / End，并在多选模式声明 `aria-multiselectable`；
- 列表容器语义仍由场景决定：导航结果优先保留原生按钮与列表结构，单选/多选候选使用 `listbox / option`，不能把搜索结果伪装成操作菜单。

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
