# design-sync NOTES

本文件由 `/design-sync` 维护，记录本仓库同步到 claude.ai/design 时的仓库特有坑。
**状态：尚未同步过。** 2026-08-07 只做了只读探查即中止（token 预算），未建项目、未构建、未上传。

## 探查结论（2026-08-07）

- **形态 = `package`（合成入口模式）**。全仓无 `.storybook/`、无 `*.stories.*`，`Glob` 已确认。
  不要因为找不到 Storybook 就去别处翻——确实没有。
- **设计系统本体 = [src/frontend/src/primitives/](../src/frontend/src/primitives/)**，barrel 是
  `src/primitives/index.ts`，29 个组件导出（A / Badge / Bold / Box / Button / LinkButton /
  Dialog / Div / Field / Form / H / Hr / Italic / Input / Link / Menu / MenuList / P / Popover /
  ScreenReaderAnnouncer / Text / ToggleButton / Ul / VerticallyOffCenter / TextArea / Switch / Icon
  外加 `useCloseDialog` hook 与 `DialogProps` 类型——后两者不是组件，注意 `componentSrcMap` 排除）。
  另有若干未进 barrel 的文件（Checkbox / Radio / Select / Separator / Spinner / Tabs / Loader /
  TooltipWrapper / VisualOnlyTooltip / FieldDescription / FieldErrors），刻意不导出，需要的话用
  `componentSrcMap` 显式加进来。
- **没有库产物**。`src/frontend/dist/` 是 Vite 出的 SPA 产物（index.html + assets），**不是**库 dist。
  `package.json` name 是 `meet`、`private: true`、无 `module`/`exports`。所以必须走合成入口：
  `--entry src/primitives/index.ts` 之类，并配 `tsconfig` 让 `@/…` 路径别名解析得开。
- `--node-modules` 指向 `src/frontend/node_modules`（react 在那里，不是仓库根）。

## 开工前必须先解决的三件事

- **样式要现生成**：Panda CSS 的产物只在 vite 构建时注入，仓库里**没有独立静态样式表**。
  `src/frontend/src/styles/index.css` 只是全局补丁（滚动条、@font-face、a11y outline），
  **不含 token / recipes / utilities 三层**，直接拿它当 `cssEntry` 会得到一堆裸样式卡片。
  正确做法：先跑 `npx panda cssgen --outfile <某个静态路径>`（cwd = `src/frontend`），
  把产出的完整 CSS 当 `cfg.cssEntry`。tokens 定义在 `panda.config.ts`，`outdir: src/styled-system`。
- **provider 大概率要配**：primitives 大量依赖 react-aria（`data-rac` 选择器满地都是），
  可能还牵 i18n / valtio store。预览白屏时按 `[RENDER]` → `cfg.provider` 那条路走。
- **字体**：`@fontsource-variable/lexend`、`atkinson-hyperlegible-next`、`opendyslexic`、
  `material-symbols-outlined`、`@fontsource/material-icons-outlined` 都在 node_modules 里，
  `[FONT_MISSING]` 时用 `cfg.extraFonts` 指过去即可，不需要外部下载。

## Re-sync risks / 待观察

- **深色模式只会呈现一档**。主题挂在 `<html data-theme="light|dark">` 上（见 `useApplyTheme`），
  预览卡默认无 `data-theme`，所以只体现浅色。要覆盖深色需要在 provider 或预览 `.tsx` 里显式打标签。
  相关既有坑见项目记忆「深色模式固定色阶坑」——`primary.*` 与 `success.100` 那批**不翻**，
  写预览时别拿它们当「随主题变化」的例子。
- **`panda cssgen` 的产物是 include 驱动的**（`include: ['./src/**/*.{js,jsx,ts,tsx}']`）：
  它按全仓源码里实际用到的原子类生成 CSS。如果同步范围只框 primitives，生成的 CSS 仍是全量，
  体积偏大但不会缺样式；反过来若将来收窄 include，预览可能突然掉样式。
- 仓库 `src/frontend` 用 npm（有 `package-lock.json`），装依赖走 `npm ci`。
- 本机 claude.ai/design 已连通授权（`list_projects` 可调），账号下当时**无任何设计系统项目**。

## 中止时的既定待决项（下次直接问用户）

1. 是否全量高保真（几小时 + 较大 token），还是先出「能导入能渲染、全部 floor card」的最小可用版。
2. 范围：仅 primitives（29） / 再加 `src/frontend/src/components/` 里的通用件（Avatar、Modal、
   ResizablePanel、StateHint、LoadingScreen…，这些耦合应用状态，provider 调试成本明显更高） /
   再加业务壳（会牵 LiveKit、IM SDK，预览大概率跑不起来，不推荐）。
3. 预览卡深度：全部手写 / 核心 ~12 个手写 / 全部 floor card（后两者都可在以后任意一次 re-sync 增量补写，已写的会保留）。
