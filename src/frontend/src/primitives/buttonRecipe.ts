import { type RecipeVariantProps, cva } from '@/styled-system/css'

/**
 * Button 视觉标准(2026-07,全站按钮基准):
 * - 圆角:常规按钮 8px(radii.8)、小按钮/图标钮 6px(radii.6);胶囊(full)只留给
 *   搜索框、筛选/建议 chip、头像,动作按钮一律不用胶囊。
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
    transition: 'background 200ms, outline 200ms, border-color 200ms',
    cursor: 'pointer',
    border: '1px solid transparent',
    '&[data-disabled]': {
      cursor: 'default',
    },
    gap: '0.5rem',
  },
  variants: {
    size: {
      default: {
        borderRadius: 8,
        paddingX: '1',
        paddingY: '0.625',
        '--square-padding': '{spacing.0.625}',
      },
      sm: {
        borderRadius: 6,
        paddingX: '0.5',
        paddingY: '0.25',
        '--square-padding': '{spacing.0.25}',
      },
      xs: {
        borderRadius: 6,
        '--square-padding': '0',
      },
      compact: {
        borderRadius: 8,
        paddingX: '0.5',
        paddingY: '0.625',
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
        borderRadius: 8,
        paddingX: '1',
        paddingY: '0.5',
        fontSize: '0.875rem',
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
       * 视觉几乎不变,只有圆角从裸 8px 归到小控件标准 6px。
       *
       * 对话框底部的主次按钮不要用这个 —— 那是「常规按钮」,走 default。
       */
      dense: {
        borderRadius: 6,
        paddingX: '0.75',
        paddingY: '0.375',
        fontSize: '0.8125rem',
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
       * 圆角一律 6px:见文件顶部标准(小控件 6px)。归位前散着 4px / 6px / 8px,
       * 其中 4px 和 8px 都是漂移。
       *
       * 配色走 variant 而非各写一套:`quaternaryText`(透明底 + 灰图标 + hover
       * 浅灰底)正是这一族该有的样子,删除类用 `quaternaryDanger`。
       */
      icon24: { borderRadius: 6, width: '1.5rem', height: '1.5rem', padding: 0 },
      icon28: {
        borderRadius: 6,
        width: '1.75rem',
        height: '1.75rem',
        padding: 0,
      },
      icon32: { borderRadius: 6, width: '2rem', height: '2rem', padding: 0 },
    },
    square: {
      true: {
        paddingX: 'var(--square-padding)',
        paddingY: 'var(--square-padding)',
      },
    },
    round: {
      true: {
        borderRadius: '50%',
        paddingX: 'var(--square-padding)',
        paddingY: 'var(--square-padding)',
      },
    },
    variant: {
      primary: {
        // P6-b: 飞书亮蓝按钮(原 DSFR 用 primary.800 深蓝做底)。
        backgroundColor: 'primary.500',
        color: 'white',
        fontWeight: 'medium !important',
        '&[data-hovered]': {
          backgroundColor: 'primary.600',
        },
        '&[data-pressed]': {
          backgroundColor: 'primary.600',
        },
        '&[data-disabled]': {
          backgroundColor: 'greyscale.100',
          color: 'greyscale.400',
        },
      },
      secondary: {
        backgroundColor: 'greyscale.000',
        color: 'primary.800',
        fontWeight: 'medium !important',
        borderColor: 'primary.800',
        // 深色:primary.* 是固定色阶不翻转,深蓝 primary.800 配深底
        // (greyscale.000→#161616)几乎不可见。文字/边框翻到 primaryDark 亮蓝,
        // 与「进入会议」(scheduledCard.text=primaryDark.700)对齐可读度。
        _dark: {
          color: 'primaryDark.700',
          borderColor: 'primaryDark.300',
        },
        '&[data-hovered]': {
          backgroundColor: 'greyscale.100',
        },
        '&[data-pressed]': {
          backgroundColor: 'greyscale.100',
        },
        // 补齐禁用态:此前 secondary 只有 base 的 cursor:default,颜色不变 ——
        // 禁用的线框按钮和可点的长得一模一样(分页「上一页」到首页时无从判断)。
        // 与 secondaryText 的禁用色对齐,边框一起褪掉。
        // 不需要 _dark:greyscale.* 本身随主题翻转(与固定色阶的 primary.* 不同)。
        '&[data-disabled]': {
          color: 'greyscale.400',
          borderColor: 'greyscale.300',
        },
      },
      secondaryText: {
        backgroundColor: 'transparent',
        fontWeight: 'medium !important',
        color: 'primary.800',
        // 深色:同 secondary,深蓝文字在深底上不可读 → 翻到 primaryDark 亮蓝。
        _dark: {
          color: 'primaryDark.700',
        },
        '&[data-hovered]': {
          backgroundColor: 'greyscale.100',
        },
        '&[data-pressed]': {
          backgroundColor: 'greyscale.100',
        },
        '&[data-disabled]': {
          color: 'greyscale.400',
        },
      },
      whiteCircle: {
        color: 'white',
        border: '1px white solid',
        width: '56px',
        height: '56px',
        borderRadius: '100%',
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
        borderColor: 'greyscale.200',
        borderRadius: '4px',
        backgroundColor: 'greyscale.50',
        padding: '0',
        flexShrink: 0,
        '&[data-hovered]': {
          backgroundColor: 'greyscale.100',
        },
        transition: 'box-shadow 0.2s ease-in-out',
        '&[data-selected]': {
          boxShadow:
            '0 0 0 3px token(colors.primary.600) inset, 0 0 0 5px white inset',
        },
        '&[data-disabled]': {
          backgroundColor: 'greyscale.100',
          color: 'greyscale.400',
          opacity: '0.7',
        },
      },
      tertiary: {
        backgroundColor: 'primary.100',
        fontWeight: 'medium !important',
        color: 'primary.800',
        '&[data-hovered]': {
          backgroundColor: 'primary.300',
        },
        '&[data-pressed]': {
          backgroundColor: 'primary.300',
        },
        '&[data-disabled]': {
          backgroundColor: 'transparent',
          color: 'primary.400',
        },
      },
      tertiaryText: {
        backgroundColor: 'transparent',
        fontWeight: 'medium !important',
        color: 'primary.900',
        '&[data-hovered]': {
          backgroundColor: 'primary.300',
        },
        '&[data-pressed]': {
          backgroundColor: 'primary.300',
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
          outlineColor: 'focusRing',
          outlineOffset: '2px',
        },
        '&[data-disabled]': {
          opacity: 0.2,
        },
      },
      quaternaryText: {
        backgroundColor: 'transparent',
        fontWeight: 'medium !important',
        color: 'greyscale.600',
        '&[data-hovered]': {
          backgroundColor: 'greyscale.100',
          color: 'greyscale.700',
        },
        '&[data-pressed]': {
          backgroundColor: 'greyscale.100',
          color: 'greyscale.700',
        },
        '&[data-disabled]': {
          backgroundColor: 'transparent',
          color: 'greyscale.300',
        },
      },
      /**
       * 删除类图标钮:平时同 quaternaryText 的中性灰,hover 才转红 —— 一排行尾
       * 动作里只有它是不可逆的,但不该在静止状态就一直喊。
       */
      quaternaryDanger: {
        backgroundColor: 'transparent',
        fontWeight: 'medium !important',
        color: 'greyscale.600',
        '&[data-hovered]': {
          backgroundColor: 'danger.50',
          color: 'danger.600',
        },
        '&[data-pressed]': {
          backgroundColor: 'danger.50',
          color: 'danger.600',
        },
        '&[data-disabled]': {
          backgroundColor: 'transparent',
          color: 'greyscale.300',
        },
      },
      greyscale: {
        backgroundColor: 'transparent',
        color: 'greyscale.400',
        '&[data-hovered]': {
          color: 'greyscale.800',
        },
        '&[data-pressed]': {
          color: 'greyscale.800',
        },
        '&[data-selected]': {
          color: 'greyscale.800',
        },
        '&[data-disabled]': {
          color: 'greyscale.200',
        },
      },
      danger: {
        backgroundColor: 'error.400',
        color: 'white',
        '&[data-hovered]': {
          backgroundColor: 'error.600',
        },
        '&[data-pressed]': {
          backgroundColor: 'error.700',
          color: 'error.200',
        },
      },
      error2: {
        backgroundColor: 'error.200',
        color: 'error.900',
        '&[data-hovered]': {
          backgroundColor: 'error.300',
        },
        '&[data-focused]': {
          backgroundColor: 'error.200',
        },
        '&[data-pressed]': {
          backgroundColor: 'error.900',
          color: 'error.100',
        },
        '&[data-selected]': {
          backgroundColor: 'error.900 !important',
          color: 'error.100 !important',
        },
        '&[data-disabled]': {
          backgroundColor: 'error.200 !important',
          color: 'error.300 !important',
        },
      },
      errorCircle: {
        backgroundColor: 'error.500',
        width: '56px',
        height: '56px',
        borderRadius: '100%',
        color: 'white',
        '&[data-hovered]': {
          backgroundColor: 'error.600',
        },
        '&[data-pressed]': {
          backgroundColor: 'error.700',
          color: 'error.200',
        },
      },
      // @TODO: better handling of colors… this is a mess
      success: {
        colorPalette: 'success',
        color: 'success.subtle-text',
        backgroundColor: 'success.subtle',
        '&[data-hovered]': {
          backgroundColor: 'success.200',
        },
        '&[data-pressed]': {
          backgroundColor: 'success.subtle!',
        },
      },
      text: {
        color: 'primary',
        '&[data-hovered]': {
          background: 'greyscale.100 !important',
          color: 'primary !important',
        },
      },
      permission: {
        position: 'relative',
        borderRadius: '100%',
        color: 'amber.500',
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
          color: 'greyscale.300',
        },
      },
    },
    fullWidth: {
      true: {
        width: 'full',
      },
    },
    loading: {
      true: {},
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
          fontSize: '13px',
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
        borderRadius: 0,
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
