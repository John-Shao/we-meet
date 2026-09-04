import { type RecipeVariantProps, cva } from '@/styled-system/css'

/**
 * Button 视觉标准(2026-07,全站按钮基准):
 * - 圆角:所有矩形按钮使用语义 token `control`(8px);圆形动作使用 `pill`。
 *   组件只声明用途，不再直接选择 4/6/8px 数字圆角。
 * - 盒高:两档,与 `sizes.control` 对齐(Input / Select 走同一套)
 *     40px  `default` / `action` / `compact`  常规按钮、对话框主次按钮
 *     32px  `sm` / `dense`                    表单内联、列表行尾
 *   例外(刻意不钉):`xs`、图标三档 icon24/28/32、以及自带 width+height 的
 *   variant(whiteCircle / bigSquare / errorCircle 56px、permission)。
 *   钉法一律是**行高 + 内边距**,不用 height/minHeight —— square/round 只有
 *   true 分支,定高会把方形图标钮拉成长方形。纯图标钮不受行高影响(flex 子项
 *   是 <svg>,line-height 对 flex item 不生效),所以会中控制栏那批仍是 46px。
 * - 填充分工:主操作=primary(实心蓝)、次操作=secondary(线框)、弱操作=
 *   secondaryText(纯文字)。新按钮优先走本基元,别再手搓 <button> + 裸圆角。
 * - 字号:`default`/`sm`/`xs`/`compact` **只管圆角和内边距,不设 font-size**,
 *   渲染大小取决于外层容器(全站 600+ 处在用且依赖这个继承行为,别去补字号——
 *   会一次性动到全站,其中落在小字号容器里的会被放大)。
 *   **自带字号的只有两档,新代码优先用它们**:
 *     `action` 14px —— 常规动作按钮(对话框「取消/确定」、页头「＋ 新建」)
 *     `dense`  13px —— 列表/面板内的小号动作按钮(「发消息」「同意」「催办」)
 *   踩过的坑:本仓库 html/body 没设 font-size,所以用 `default` 的按钮在对话框里
 *   会吃到浏览器默认 16px,比同框 14px 的字段标签大一号。
 * - 图标钮:走 `icon24/icon28/icon32` 三档固定盒子 + `quaternaryText`
 *   (删除类用 `quaternaryDanger`),按容器密度选档,别再手搓 width/height。
 * - 行内文字链(齐边缘、无盒子的「更换」「复制」这类)**不属于本基元** ——
 *   基元每档都带 paddingX 会把文字推离边缘,那类走 `@/styles/controls`
 *   的 linkBtnCls。
 */
export const buttonRecipe = cva({
  base: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    transition:
      'background token(durations.slow), outline token(durations.slow), border-color token(durations.slow)',
    cursor: 'pointer',
    border: '1px solid transparent',
    '&[data-disabled]': {
      cursor: 'default',
    },
    gap: 'sm',
  },
  variants: {
    size: {
      /**
       * 常规按钮盒高 40px(= sizes.control.lg),与 `action` 同几何、只差字号。
       *
       * ⚠️ 这一档**从来就不是定高**:它不设 font-size,盒高 = 继承行高 + 内边距,
       * 于是同一个按钮在 16px 容器里 46px、14px 容器里 43px、13px 容器里 41.5px。
       * 46px 那档最扎眼 —— 对话框里 32px 的输入框配 46px 的「取消/确定」,壮一圈。
       *
       * 收口手法与 `sm`/`action`/`dense` 一致:**钉行高、不碰字号**。
       *   22(lineHeight) + 16(paddingY×2) + 2(border) = 40
       * 字号仍然继承,所以顶部注释里那条红线依然成立 —— 198 处调用点的**文字大小
       * 一个都没动**,只是盒子不再跟着字号飘。想要 14px 字仍然去用 `action`。
       *
       * 为什么不用 `height: 'control.lg'`:square/round 只有 true 分支,定高会把
       * 方形图标钮拉成长方形(同 `sm` 那条注释)。
       *
       * `--square-padding` **刻意留在 0.625**:走 square 的是会中控制栏那批纯图标
       * toggle(麦克风/摄像头/共享/聊天/举手…),它们的 flex 子项是 <svg>,
       * line-height 对 flex item 不生效,盒高 = 图标 24 + 20 + 2 = 46px 原样不变。
       * 那是触摸目标不是表单控件,46px 正合适,别顺手一起收。
       */
      default: {
        borderRadius: 'control',
        paddingX: '1',
        paddingY: '0.5',
        lineHeight: '22px',
        '--square-padding': '{spacing.0.625}',
      },
      sm: {
        borderRadius: 'control',
        paddingX: '0.5',
        paddingY: '0.25',
        // 行高钉住盒高:22 + 8(padY) + 2(border) = 32 = sizes.control.md,
        // 与 Input / Select 齐平。改行高而不是加 minHeight —— square/round
        // 只有 true 分支,minHeight 会把方形图标钮拉成长方形。
        lineHeight: '22px',
        '--square-padding': '{spacing.0.25}',
      },
      xs: {
        borderRadius: 'control',
        '--square-padding': '0',
      },
      /**
       * = `default` 但横向内边距收一半(1rem → 0.5rem)。纵向几何与 default 完全
       * 一致,所以同样钉到 40px —— 否则全站只剩它一个 46px 的孤儿档。
       *
       * 唯一调用点是录制面板的主操作按钮(fullWidth,横向内边距其实不起作用)。
       */
      compact: {
        borderRadius: 'control',
        paddingX: '0.5',
        paddingY: '0.5',
        lineHeight: '22px',
        '--square-padding': '{spacing.0.625}',
      },
      /**
       * 常规动作按钮(对话框底部的「取消 / 确定」、页头的「＋ 新建日程」这类)。
       * **新代码要的基本都是这一档,不是 `default`。**
       *
       * 它存在的理由是自带 14px 字号:`default` 不设字号,渲染出来取决于外层容器,
       * 而本仓库 html/body 没设 font-size,于是对话框里的按钮会吃到浏览器默认的
       * 16px,比同框 14px 的字段标签明显大一号(实测反馈:「新建日程」「创建」
       * 「取消」看上去不协调)。
       *
       * 那为什么不直接给 `default` 补字号?——全站 600+ 处在用它、且依赖继承,
       * 其中落在 13px 容器里的会被这一改**放大**,影响面无法逐个目视核对。
       * 所以新增一档 opt-in,`default` 留给既有调用点不动。
       *
       * 尺寸不是拍的,取自归位前这批按钮手搓时的实际写法:字号 12 个样本全是
       * 0.875rem,纵向内边距 18 个样本全是 0.5rem。
       *
       * ⚠️ 纵向内边距**刻意不等于** `default` 的 0.625rem —— 初版照抄了 default
       * 的几何,结果按钮比归位前高了 4px(实测反馈「按钮比修改之前高一些」)。
       * 这一档的定位是「还原既有规范」,不是「继承 default」,别再改回去对齐。
       */
      action: {
        borderRadius: 'control',
        paddingX: '1',
        paddingY: '0.5',
        textStyle: 'labelLarge',
        // 22 + 16 + 2 = 40 = sizes.control.lg。原先靠继承行高(1.5→21px)
        // 算出 39,差 1px 落不到档上。
        // 行高取 22 而非字号配对表里的 20:按钮文字是 flex 居中的单行,
        // 行高在这里纯粹是盒模型算术,不参与正文排版节奏。
        lineHeight: '22px',
        '--square-padding': '{spacing.0.5}',
      },
      /**
       * 列表/面板内的小号动作按钮(「发消息」「同意」「催办」「呼叫」这类)。
       *
       * ⚠️ 唯一一个**自带 font-size** 的刻度,这是它存在的理由:其余刻度只管圆角和
       * 内边距,字号继承上下文。正文容器是 16px,而这类按钮该是 13px —— 以前每个调用
       * 点各自 `fontSize: '0.8125rem'` 手拍,同一行里就出现过一个继承 16px、一个
       * 13px 的不一致(通讯录「添加」vs「发消息」)。字号收进这里,调用点不用再写。
       *
       * 尺寸刻意对齐原先手搓的那套(0.75rem / 0.375rem / 13px),所以旧按钮换过来
       * 视觉几乎不变,圆角统一归到 `control` 语义 token。
       *
       * 对话框底部的主次按钮不要用这个 —— 那是「常规按钮」,走 default。
       */
      dense: {
        borderRadius: 'control',
        paddingX: '0.75',
        paddingY: '0.375',
        textStyle: 'labelMedium',
        // 18 + 12 + 2 = 32 = sizes.control.md(与 13px 字号的配对行高一致)。
        lineHeight: '18px',
        '--square-padding': '{spacing.0.375}',
      },
      /**
       * ── 图标钮的三档固定盒子(icon24 / icon28 / icon32)────────────────
       *
       * 与其他刻度不同,这三档给的是**固定 width/height**,不是内边距。图标钮
       * 要的是可预测的方框:走 `square` 的内边距刻度时盒子大小取决于图标的
       * size prop,两个调用点传 16 和 18 就会得到两个不一样的框。
       *
       * 三档按容器密度选,不要压成一个数 —— 尺寸差异在这里是有意义的:
       *   icon24 树行 / 迷你日历格 / 忙闲面板翻页
       *   icon28 表格行动作 / 对话框标题栏动作
       *   icon32 面板头 / 日历工具栏
       *
       * 圆角一律使用 `control`:归位前散着 4px / 6px / 8px，现在由共享契约统一。
       *
       * 配色走 variant 而非各写一套:`quaternaryText`(透明底 + 灰图标 + hover
       * 浅灰底)正是这一族该有的样子,删除类用 `quaternaryDanger`。
       */
      icon24: {
        borderRadius: 'control',
        width: 'iconButton.compact',
        height: 'iconButton.compact',
        padding: 0,
      },
      icon28: {
        borderRadius: 'control',
        width: 'iconButton.default',
        height: 'iconButton.default',
        padding: 0,
      },
      icon32: {
        borderRadius: 'control',
        width: 'iconButton.large',
        height: 'iconButton.large',
        padding: 0,
      },
    },
    square: {
      true: {
        paddingX: 'var(--square-padding)',
        paddingY: 'var(--square-padding)',
      },
    },
    round: {
      true: {
        borderRadius: 'pill',
        paddingX: 'var(--square-padding)',
        paddingY: 'var(--square-padding)',
      },
    },
    variant: {
      primary: {
        backgroundColor: 'action.primary.bg',
        color: 'action.primary.text',
        fontWeight: 'medium !important',
        '&[data-hovered]': {
          backgroundColor: 'action.primary.hover',
        },
        '&[data-pressed]': {
          backgroundColor: 'action.primary.pressed',
        },
        '&[data-disabled]': {
          backgroundColor: 'surface.canvas',
          color: 'text.disabled',
        },
      },
      secondary: {
        backgroundColor: 'surface.default',
        color: 'text.link',
        fontWeight: 'medium !important',
        borderColor: 'border.focus',
        '&[data-hovered]': {
          backgroundColor: 'surface.canvas',
        },
        '&[data-pressed]': {
          backgroundColor: 'action.selected.bg',
        },
        // 补齐禁用态:此前 secondary 只有 base 的 cursor:default,颜色不变 ——
        // 禁用的线框按钮和可点的长得一模一样(分页「上一页」到首页时无从判断)。
        // 与 secondaryText 的禁用色对齐,边框一起褪掉。
        // 不需要 _dark:greyscale.* 本身随主题翻转(与固定色阶的 primary.* 不同)。
        '&[data-disabled]': {
          color: 'text.disabled',
          borderColor: 'border.subtle',
        },
      },
      secondaryText: {
        backgroundColor: 'transparent',
        fontWeight: 'medium !important',
        color: 'text.link',
        '&[data-hovered]': {
          backgroundColor: 'surface.canvas',
        },
        '&[data-pressed]': {
          backgroundColor: 'action.selected.bg',
        },
        '&[data-disabled]': {
          color: 'text.disabled',
        },
      },
      whiteCircle: {
        color: 'white',
        border: '1px white solid',
        width: '56px',
        height: '56px',
        borderRadius: 'pill',
        '&[data-hovered]': {
          backgroundColor: 'greyscale.100/20',
        },
        '&[data-pressed]': {
          backgroundColor: 'greyscale.100/50',
        },
      },
      bigSquare: {
        width: '56px',
        height: '56px',
        borderColor: 'border.subtle',
        borderRadius: 'extraSmall',
        backgroundColor: 'surface.canvas',
        padding: '0',
        flexShrink: 0,
        '&[data-hovered]': {
          backgroundColor: 'action.selected.bg',
        },
        transition: 'box-shadow token(durations.slow) ease-in-out',
        '&[data-selected]': {
          boxShadow:
            '0 0 0 3px token(colors.action.primary.bg) inset, 0 0 0 5px token(colors.surface.default) inset',
        },
        '&[data-disabled]': {
          backgroundColor: 'surface.canvas',
          color: 'text.disabled',
          opacity: '0.7',
        },
      },
      tertiary: {
        backgroundColor: 'action.selected.bg',
        fontWeight: 'medium !important',
        color: 'action.selected.text',
        '&[data-hovered]': {
          backgroundColor: 'action.selected.bg',
        },
        '&[data-pressed]': {
          backgroundColor: 'action.selected.bg',
        },
        '&[data-disabled]': {
          backgroundColor: 'transparent',
          color: 'text.disabled',
        },
      },
      tertiaryText: {
        backgroundColor: 'transparent',
        fontWeight: 'medium !important',
        color: 'text.link',
        '&[data-hovered]': {
          backgroundColor: 'action.selected.bg',
        },
        '&[data-pressed]': {
          backgroundColor: 'action.selected.bg',
        },
      },
      primaryDark: {
        backgroundColor: 'primaryDark.100',
        fontWeight: 'medium !important',
        color: 'white',
        '&[data-pressed]': {
          backgroundColor: 'primaryDark.900',
          color: 'primaryDark.100',
        },
        '&[data-disabled]': {
          backgroundColor: 'primaryDark.75',
          color: 'primaryDark.300',
        },
        '&[data-hovered]': {
          backgroundColor: 'primaryDark.300',
          color: 'white',
        },
        '&[data-selected]': {
          backgroundColor: 'primaryDark.700 !important',
          color: 'primaryDark.100 !important',
        },
      },
      secondaryDark: {
        backgroundColor: 'primaryDark.50',
        fontWeight: 'medium !important',
        color: 'white',
        '&[data-pressed]': {
          backgroundColor: 'primaryDark.200',
        },
        '&[data-hovered]': {
          backgroundColor: 'primaryDark.100',
          color: 'white',
        },
        '&[data-selected]': {
          backgroundColor: 'primaryDark.700 !important',
          color: 'primaryDark.100 !important',
        },
      },
      primaryTextDark: {
        backgroundColor: 'transparent',
        fontWeight: 'medium !important',
        color: 'white',
        '&[data-hovered]': {
          backgroundColor: 'primaryDark.100',
        },
        '&[data-pressed]': {
          backgroundColor: 'primaryDark.700',
          color: 'primaryDark.100',
        },
        '&[data-selected]': {
          backgroundColor: 'primaryDark.700',
          color: 'primaryDark.100',
        },
        '&[data-focus-visible]': {
          outline: '2px solid',
          outlineColor: 'border.focus',
          outlineOffset: '2px',
        },
        '&[data-disabled]': {
          opacity: 0.2,
        },
      },
      quaternaryText: {
        backgroundColor: 'transparent',
        fontWeight: 'medium !important',
        color: 'icon.secondary',
        '&[data-hovered]': {
          backgroundColor: 'surface.canvas',
          color: 'icon.primary',
        },
        '&[data-pressed]': {
          backgroundColor: 'action.selected.bg',
          color: 'action.selected.text',
        },
        '&[data-disabled]': {
          backgroundColor: 'transparent',
          color: 'icon.disabled',
        },
      },
      /**
       * 删除类图标钮:平时同 quaternaryText 的中性灰,hover 才转红 —— 一排行尾
       * 动作里只有它是不可逆的,但不该在静止状态就一直喊。
       */
      quaternaryDanger: {
        backgroundColor: 'transparent',
        fontWeight: 'medium !important',
        color: 'icon.secondary',
        '&[data-hovered]': {
          backgroundColor: 'status.danger.container',
          color: 'status.danger.container-text',
        },
        '&[data-pressed]': {
          backgroundColor: 'status.danger.container',
          color: 'status.danger.container-text',
        },
        '&[data-disabled]': {
          backgroundColor: 'transparent',
          color: 'icon.disabled',
        },
      },
      greyscale: {
        backgroundColor: 'transparent',
        color: 'icon.secondary',
        '&[data-hovered]': {
          color: 'icon.primary',
        },
        '&[data-pressed]': {
          color: 'icon.primary',
        },
        '&[data-selected]': {
          color: 'icon.primary',
        },
        '&[data-disabled]': {
          color: 'icon.disabled',
        },
      },
      danger: {
        backgroundColor: 'status.danger',
        color: 'status.danger.text',
        '&[data-hovered]': {
          backgroundColor: 'status.danger',
        },
        '&[data-pressed]': {
          backgroundColor: 'status.danger.container',
          color: 'status.danger.container-text',
        },
      },
      error2: {
        backgroundColor: 'status.danger.container',
        color: 'status.danger.container-text',
        '&[data-hovered]': {
          backgroundColor: 'status.danger.container',
        },
        '&[data-focused]': {
          backgroundColor: 'status.danger.container',
        },
        '&[data-pressed]': {
          backgroundColor: 'status.danger',
          color: 'status.danger.text',
        },
        '&[data-selected]': {
          backgroundColor: 'status.danger!',
          color: 'status.danger.text!',
        },
        '&[data-disabled]': {
          backgroundColor: 'surface.canvas!',
          color: 'text.disabled!',
        },
      },
      errorCircle: {
        backgroundColor: 'status.danger',
        width: '56px',
        height: '56px',
        borderRadius: 'pill',
        color: 'status.danger.text',
        '&[data-hovered]': {
          backgroundColor: 'status.danger',
        },
        '&[data-pressed]': {
          backgroundColor: 'status.danger.container',
          color: 'status.danger.container-text',
        },
      },
      success: {
        color: 'status.success.container-text',
        backgroundColor: 'status.success.container',
        '&[data-hovered]': {
          backgroundColor: 'status.success.container',
        },
        '&[data-pressed]': {
          backgroundColor: 'status.success.container!',
        },
      },
      text: {
        color: 'text.link',
        '&[data-hovered]': {
          background: 'surface.canvas!',
          color: 'text.link!',
        },
      },
      permission: {
        position: 'relative',
        borderRadius: 'pill',
        color: 'status.warning',
        width: 'fit-content',
        height: 'fit-content',
        padding: '0 !important',
        margin: '0 !important',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      },
    },
    invisible: {
      true: {
        borderColor: 'none!',
        backgroundColor: 'none!',
        '&[data-hovered]': {
          backgroundColor: 'none!',
          borderColor: 'colorPalette.active!',
        },
        '&[data-pressed]': {
          borderColor: 'currentcolor',
        },
        '&[data-disabled]': {
          color: 'icon.disabled',
        },
      },
    },
    fullWidth: {
      true: {
        width: 'full',
      },
    },
    loading: {
      true: {
        cursor: 'progress',
        '&[data-disabled]': {
          cursor: 'progress',
        },
      },
    },
    // some toggle buttons make more sense without a "pushed button" style when selected because their content changes to mark the state
    shySelected: {
      true: {},
    },
    description: {
      true: {
        flexDirection: 'column',
        gap: '0.5rem',
        '& span': {
          fontSize: '0.8125rem',
          textAlign: 'center',
        },
      },
    },
    // if the button is next to other ones to make a "button group", tell where the button is to handle radius
    groupPosition: {
      left: {
        borderTopRightRadius: 0,
        borderBottomRightRadius: 0,
      },
      right: {
        borderTopLeftRadius: 0,
        borderBottomLeftRadius: 0,
        borderLeft: 0,
      },
      center: {
        borderRadius: 'none',
      },
    },
  },
  compoundVariants: [
    {
      variant: 'primaryDark',
      shySelected: true,
      css: {
        '&[data-selected]': {
          backgroundColor: 'primaryDark.100',
          color: 'white',
        },
      },
    },
  ],
  defaultVariants: {
    size: 'default',
    variant: 'primary',
  },
})

export type ButtonRecipe = typeof buttonRecipe

export type ButtonRecipeProps = RecipeVariantProps<ButtonRecipe>
