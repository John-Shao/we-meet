import pandaPreset from '@pandacss/preset-panda'
import {
  Config,
  Tokens,
  defineConfig,
  defineSemanticTokens,
  defineTextStyles,
  defineTokens,
} from '@pandacss/dev'

const spacing: Tokens['spacing'] = {
  0: { value: '0rem' },
  0.125: { value: '0.125rem' },
  0.25: { value: '0.25rem' },
  0.375: { value: '0.375rem' },
  0.5: { value: '0.5rem' },
  0.625: { value: '0.625rem' },
  0.75: { value: '0.75rem' },
  1: { value: '1rem' },
  1.25: { value: '1.25rem' },
  1.5: { value: '1.5rem' },
  1.75: { value: '1.75rem' },
  2: { value: '2rem' },
  2.25: { value: '2.25rem' },
  2.5: { value: '2.5rem' },
  2.75: { value: '2.75rem' },
  3: { value: '3rem' },
  3.5: { value: '3.5rem' },
  4: { value: '4rem' },
}

const config: Config = {
  preflight: true,
  include: ['./src/**/*.{js,jsx,ts,tsx}'],
  exclude: [],
  jsxFramework: 'react',
  outdir: 'src/styled-system',
  globalFontface: {},
  // 深色模式:主题挂在 <html data-theme="light|dark"> 上(见 useApplyTheme)。
  // 语义 token 的 _dark 值据此切换,greyscale 采用「镜像反转」——浅色值一字不改,
  // 深色值 = 其对称档位的浅色值,故对比度不变、明暗互换。
  conditions: {
    extend: {
      dark: '[data-theme=dark] &',
      light: '[data-theme=light] &',
    },
  },
  globalCss: {
    'html, body': {
      backgroundColor: 'greyscale.000',
      color: 'greyscale.1000',
    },
    // 用户在系统里开了「减弱动态效果」时,全站动效统一压掉。
    //
    // 做成兜底规则而不是逐组件处理:动效散在 ~50 处 transition/animation 里,
    // 还有 react-aria / LiveKit 这些第三方自带的进出场动画,逐个改既漏又难维护。
    //
    // ⚠️ 用 0.01ms 而不是 0 —— transitionend / animationend 仍会触发。react-aria
    // 的 data-entering / data-exiting 靠动画结束事件决定卸载时机,真写 0 会让
    // 弹层卡在退出态不消失。
    //
    // Spinner 不受影响:它自己已经做了处理(reduced-motion 下隐藏旋转 SVG、
    // 换成静态沙漏图标),所以加载状态仍然表达得出来。
    '@media (prefers-reduced-motion: reduce)': {
      '*, *::before, *::after': {
        animationDuration: '0.01ms !important',
        animationIterationCount: '1 !important',
        transitionDuration: '0.01ms !important',
        scrollBehavior: 'auto !important',
      },
    },
  },
  theme: {
    ...pandaPreset.theme,
    // media queries are defined in em so that zooming with text-only mode triggers breakpoints
    breakpoints: {
      xs: '22.6em', // 360px (we assume less than that are old/entry level mobile phones)
      xsm: '31.25em', // 500px,
      sm: '40em', // 640px
      md: '48em', // 768px
      lg: '64em', // 1024px
      xl: '80em', // 1280px
      '2xl': '96em', // 1536px
    },
    keyframes: {
      slide: {
        from: {
          transform: 'var(--origin)',
          opacity: 0,
        },
        to: {
          transform: 'translateY(0)',
          opacity: 1,
        },
      },
      fade: { from: { opacity: 0 }, to: { opacity: 1 } },
      blink: {
        '0%, 50%': { opacity: 1 },
        '50.01%, 100%': { opacity: 0 },
      },
      pulse: {
        '0%': { boxShadow: '0 0 0 0 rgba(255, 255, 255, 0.7)' },
        '75%': { boxShadow: '0 0 0 30px rgba(255, 255, 255, 0)' },
        '100%': { boxShadow: '0 0 0 0 rgba(255, 255, 255, 0)' },
      },
      active_speaker: {
        '0%': { height: '25%' },
        '25%': { height: '45%' },
        '50%': { height: '20%' },
        '100%': { height: '55%' },
      },
      active_speaker_small: {
        '0%': { height: '20%' },
        '25%': { height: '25%' },
        '50%': { height: '18%' },
        '100%': { height: '25%' },
      },
      wave_hand: {
        '0%': { transform: 'rotate(0deg)' },
        '20%': { transform: 'rotate(-20deg)' },
        '80%': { transform: 'rotate(20deg)' },
        '100%': { transform: 'rotate(0)' },
      },
      pulse_background: {
        '0%': { opacity: '1' },
        '50%': { opacity: '0.65' },
        '100%': { opacity: '1' },
      },
      rotate: {
        '0%': {
          transform: 'rotate(0deg)',
        },
        '100%': {
          transform: 'rotate(360deg)',
        },
      },
      prixClipFix: {
        '0%': {
          clipPath: 'polygon(50% 50%, 0 0, 0 0, 0 0, 0 0, 0 0)',
        },
        '25%': {
          clipPath: 'polygon(50% 50%, 0 0, 100% 0, 100% 0, 100% 0, 100% 0)',
        },
        '50%': {
          clipPath:
            'polygon(50% 50%, 0 0, 100% 0, 100% 100%, 100% 100%, 100% 100%)',
        },
        '75%': {
          clipPath: 'polygon(50% 50%, 0 0, 100% 0, 100% 100%, 0 100%, 0 100%)',
        },
        '100%': {
          clipPath: 'polygon(50% 50%, 0 0, 100% 0, 100% 100%, 0 100%, 0 0)',
        },
      },
    },
    tokens: defineTokens({
      /* we take a few things from the panda preset but for now we clear out some stuff.
       * This way we'll only add the things we need step by step and prevent using lots of differents things.
       */
      ...pandaPreset.theme.tokens,
      colors: defineTokens.colors({
        ...pandaPreset.theme.tokens.colors,
        // P6-b2: 暗色阶(会中 UI + 菜单/弹层/Select 暗色变体)紫→飞书蓝。
        // 保每阶亮度、仅换蓝相,故对比度不变:50 最深(深色面)→950 最浅。
        primaryDark: {
          50: { value: '#0E1626' },
          75: { value: '#161E33' },
          100: { value: '#1E2A47' },
          200: { value: '#2E4068' },
          300: { value: '#3E558C' },
          400: { value: '#5570B8' },
          500: { value: '#6E8CDB' },
          600: { value: '#88A2E4' },
          700: { value: '#A3B8EC' },
          800: { value: '#C0CFF3' },
          900: { value: '#DCE6FB' },
          950: { value: '#F2F6FE' },
          action: { value: '#AEC6FF' },
        },
        // P6-b: 飞书蓝。500=#3370FF(主强调/按钮),50/100 浅蓝(底/高亮),
        // 600/700 中深蓝(hover/文字),800-950 深蓝(深色面/文字)。
        primary: {
          50: { value: '#EBF1FF' },
          100: { value: '#D6E4FF' },
          200: { value: '#B7D0FF' },
          300: { value: '#94B8FF' },
          400: { value: '#5C8DFF' },
          500: { value: '#3370FF' },
          600: { value: '#2860D9' },
          700: { value: '#1E4DB3' },
          800: { value: '#16357F' },
          900: { value: '#0F2657' },
          950: { value: '#091633' },
          action: { value: '#1456F0' },
        },
        // greyscale 移到 semanticTokens(见下)以支持深色镜像反转。
        error: {
          100: { value: '#261212' },
          200: { value: '#6C302E' },
          300: { value: '#983533' },
          400: { value: '#CA3632' },
          500: { value: '#EF413D' },
          600: { value: '#EE6A66' },
          700: { value: '#F28D8A' },
          800: { value: '#F6AFAD' },
          900: { value: '#FAD2D1' },
          950: { value: '#FFF4F4' },
        },
      }),
      animations: {},
      blurs: {},
      /* just directly use values as tokens. This allows us to follow a specific design scale,
       * without having to remember what 'sm' or '2xl' actually means.
       *
       * see semanticTokens for tokens targeting specific usages
       */
      fonts: {
        sans: {
          value: [
            'ui-sans-serif',
            'system-ui',
            '-apple-system',
            'BlinkMacSystemFont',
            '"Segoe UI"',
            'Roboto',
            '"Helvetica Neue"',
            'Arial',
            '"Noto Sans"',
            'sans-serif',
            '"Apple Color Emoji"',
            '"Segoe UI Emoji"',
            '"Segoe UI Symbol"',
            '"Noto Color Emoji"',
          ],
        },
        serif: {
          value: [
            'ui-serif',
            'Georgia',
            'Cambria',
            '"Times New Roman"',
            'Times',
            'serif',
          ],
        },
        mono: {
          value: [
            'Source Code Pro',
            'ui-monospace',
            'SFMono-Regular',
            'Menlo',
            'Monaco',
            'Consolas',
            '"Liberation Mono"',
            '"Courier New"',
            'monospace',
          ],
        },
      },
      fontSizes: {
        10: { value: '0.625rem' },
        12: { value: '0.75rem' },
        14: { value: '0.875rem' },
        16: { value: '1rem' },
        20: { value: '1.25rem' },
        24: { value: '1.5rem' },
        28: { value: '1.75rem' },
        32: { value: '2rem' },
        40: { value: '2.375rem' },
        48: { value: '3rem' },
        64: { value: '4rem' },
      },
      letterSpacings: {},
      shadows: {
        sm: {
          value: [
            '0 1px 3px 0 rgb(0 0 0 / 0.1)',
            '0 1px 2px -1px rgb(0 0 0 / 0.1)',
          ],
        },
      },
      lineHeights: {
        1: { value: '1' },
        1.25: { value: '1.25' },
        1.375: { value: '1.375' },
        1.5: { value: '1.5' },
        1.625: { value: '1.625' },
        2: { value: '2' },
      },
      radii: {
        4: { value: '0.25rem' },
        6: { value: '0.375rem' },
        8: { value: '0.5rem' },
        16: { value: '1rem' },
        full: { value: '9999px' },
      },
      sizes: {
        ...spacing,
        full: { value: '100%' },
        min: { value: 'min-content' },
        max: { value: 'max-content' },
        fit: { value: 'fit-content' },
        // room layout
        'room-side-panel': { value: '360px' },
        'room-side-panel-margin': { value: '1.5rem' },
        'room-control-bar': { value: '80px' },
        'room-reaction-toolbar-height': { value: '42px' },
      },
      spacing,
      /**
       * 层级表。对标 Semi 的 z-index 分层,核心不是数值而是**顺序**:
       * 贴附 < 面板浮层 < 全局吸顶 < 模态 < 全局接管 < 浮动提示 < 跳转链接。
       *
       * 引入前全站是 13 个各自拍脑袋的裸数字(1/2/3/5/10/20/21/30/50/100/
       * 1000/2000/9999),没人说得清谁该压谁 —— 这类问题的典型症状是「某个
       * 弹层偶尔被挡住」,极难查。
       *
       * 数值刻意沿用迁移前的原值,保证零视觉变化;唯一的例外是 tooltip 从
       * 9999 降到 9000,让 skipLink 独占最顶 —— 跳转链接是无障碍入口,任何
       * 情况下都必须可见可达。
       *
       * ⚠️ 组件内部的局部堆叠(sticky 列头、网格叠层那些 1/2/3)不要用这里的
       * token:它们只在自己父级的堆叠上下文内比较,和全局层级无关,混用反而
       * 会让人误以为它们参与全局排序。
       */
      /**
       * 动效时长。取值沿用迁移前实际在用的档位,不是照抄 Semi ——
       * 全站原本 200ms(20 处)/150ms(13 处)/120ms(5 处)三档占了绝大多数,
       * 只是同一个值有两种写法(`0.2s` 和 `200ms`、`.15s` 和 `150ms`),
       * 看起来像十几个档位,其实没那么乱。
       *
       * 用法:可以直接写在 transition 简写里 —— `transition: 'opacity token(durations.fast)'`。
       * 无障碍:开了「减弱动态效果」时全站动效由 globalCss 里的兜底规则统一压掉,
       * 不需要每个调用点各自处理(见 globalCss 的 prefers-reduced-motion 块)。
       */
      durations: {
        fast: { value: '120ms' }, // 微交互:hover/焦点变色、小图标旋转
        normal: { value: '150ms' }, // 退出动画、状态切换
        slow: { value: '200ms' }, // 进入动画、面板展开收起
      },
      /**
       * 缓动。只收 standard 一个 —— 它原本有三种写法(`0.4,0,0.2,1` 带空格 /
       * 不带空格 / `.4,0,.2,1` 省略前导 0),是真正需要统一的那个。
       * `ease-in` / `ease-out` 这类 CSS 关键字不包 token:包了只是加一层间接,
       * 读的人还得回来查它等于什么。
       */
      easings: {
        standard: { value: 'cubic-bezier(0.4, 0, 0.2, 1)' },
      },
      zIndex: {
        handle: { value: 5 }, // 面板拖拽手柄
        docked: { value: 10 }, // 贴附于内容的小浮层(输入框上方弹层)
        panel: { value: 20 }, // 面板级遮罩 / 展开层
        panelTop: { value: 21 }, // 压在上述遮罩之上的内容
        callBar: { value: 30 }, // 来电条
        fab: { value: 50 }, // 悬浮操作按钮
        sticky: { value: 100 }, // sticky 页头 / 会中控制栏
        modal: { value: 1000 }, // 模态框、对话框、右键菜单
        takeover: { value: 2000 }, // 全局接管层:来电浮层、图片灯箱
        tooltip: { value: 9000 }, // 浮动提示
        skipLink: { value: 9999 }, // 无障碍跳转链接,永远最顶
      },
    }),
    semanticTokens: defineSemanticTokens({
      colors: {
        // greyscale 镜像反转:base = 原浅色值(一字不改,浅色零回归风险);
        // _dark = 对称档位的浅色值(000↔1000, 50↔950, …, 500 居中不变)。
        // 文字用 900/1000、背景用 000/50/100,反转后自动明暗互换。
        greyscale: {
          '000': { value: { base: '#FFFFFF', _dark: '#161616' } },
          50: { value: { base: '#F6F6F6', _dark: '#1E1E1E' } },
          100: { value: { base: '#EEEEEE', _dark: '#242424' } },
          200: { value: { base: '#E5E5E5', _dark: '#2A2A2A' } },
          250: { value: { base: '#DDDDDD', _dark: '#353535' } },
          300: { value: { base: '#CECECE', _dark: '#3A3A3A' } },
          400: { value: { base: '#929292', _dark: '#666666' } },
          500: { value: { base: '#7C7C7C', _dark: '#7C7C7C' } },
          600: { value: { base: '#666666', _dark: '#929292' } },
          700: { value: { base: '#3A3A3A', _dark: '#CECECE' } },
          750: { value: { base: '#353535', _dark: '#DDDDDD' } },
          800: { value: { base: '#2A2A2A', _dark: '#E5E5E5' } },
          900: { value: { base: '#242424', _dark: '#EEEEEE' } },
          950: { value: { base: '#1E1E1E', _dark: '#F6F6F6' } },
          1000: { value: { base: '#161616', _dark: '#FFFFFF' } },
        },
        default: {
          text: { value: '{colors.greyscale.1000}' },
          bg: { value: '{colors.greyscale.000}' },
          // gray.* → greyscale.*(会翻转):让走 default/control/box 语义 token 的
          // primitives(Input/Select/Box/Menu/Tabs/Popover…)在深色下自动适配。
          subtle: { value: '{colors.greyscale.100}' },
          'subtle-text': { value: '{colors.greyscale.600}' },
        },
        // 一级导航栏底色:浅色=飞书蓝 #DEE4F5,深色=暗navy(随主题翻转)。
        railBg: { value: { base: '#DEE4F5', _dark: '#1C2130' } },
        // 品牌蓝「随主题翻转」色阶 —— 裸 primary.* 的替代品。
        //
        // 为什么需要:上面 tokens.colors.primary.* 是**固定色阶**,只在 :root 定义,
        // 没有 [data-theme=dark] 覆盖。裸写 `backgroundColor: 'primary.50'` 在深色下
        // 就是一条刺眼的浅蓝亮带;而只要配套的文字继承了会翻转的 default.text(深色
        // 下是白),白字压浅蓝底直接不可读 —— Layout/Screen/录制面板都栽在这里。
        // 反过来「文字翻了、底色忘了翻」则是两个浅蓝叠在一起,对比度只剩 1.15:1。
        //
        // 规则分两类:
        //
        // ① **底面档(50 / 100)——深色用半透明,不用平行色阶**。
        //    对标 Semi Design 的 `--semi-color-primary-light-*`:它深色下一律
        //    `rgba(主色, .2/.3/.4)` 而不是切到另一套色阶。半透明色是**相对于身后
        //    的表面合成**的,于是天然不可能比背景更深 —— 早先 50 档必须特判成
        //    primaryDark.75 而非 .50(#0E1626 比页面底 #161616 还深,浅蓝卡片会翻成
        //    一个「洞」),换成 alpha 后这个特判直接不存在了;卡片叠在页面底、
        //    greyscale.50 面板、还是更高层的浮层上,都自动成立。
        //    alpha 取值是回算出来的,刻意贴住换法前已验收的观感:
        //      .12 → #1A2133(原 #161E33)   .20 → #1C2845(原 #1E2A47)
        //    对比度不降:brand.700 压 50 档 8.1:1、压 100 档 7.4:1,均过 AAA。
        //    ⚠️ rgb 分量是 primary.500(#3370FF)展开的字面量 —— CSS 无法对 hex
        //    变量取 alpha,而 color-mix() 的支持线高于本项目的构建 target。
        //    改品牌色时这两行要跟着改。
        //
        // ② 描边与文字档(200–900)——深色仍走 primaryDark.N 实色。
        //    它们不存在「比背景还深」的问题(描边压在面上、文字要可预测的对比度),
        //    实色更稳。
        //
        // 浅色一律 primary.N 原值,零回归。
        //
        // 用法:凡「浅蓝底 / 浅蓝描边 / 蓝字」的面,一律 brand.N 顶替 primary.N。
        // 不必换的两类:① 实心按钮(primary.500 底 + 白字),中调蓝两套主题都成立;
        // ② 会中 UI(features/rooms、room-ai、reactions),舞台底是恒定 primaryDark.50,
        // 那里的浅蓝是「深底上的强调色」,翻过去反而变成深蓝压深底。
        brand: {
          50: { value: { base: '{colors.primary.50}', _dark: 'rgba(51, 112, 255, 0.12)' } },
          100: { value: { base: '{colors.primary.100}', _dark: 'rgba(51, 112, 255, 0.2)' } },
          200: { value: { base: '{colors.primary.200}', _dark: '{colors.primaryDark.200}' } },
          300: { value: { base: '{colors.primary.300}', _dark: '{colors.primaryDark.300}' } },
          400: { value: { base: '{colors.primary.400}', _dark: '{colors.primaryDark.400}' } },
          500: { value: { base: '{colors.primary.500}', _dark: '{colors.primaryDark.500}' } },
          600: { value: { base: '{colors.primary.600}', _dark: '{colors.primaryDark.600}' } },
          700: { value: { base: '{colors.primary.700}', _dark: '{colors.primaryDark.700}' } },
          800: { value: { base: '{colors.primary.800}', _dark: '{colors.primaryDark.800}' } },
          900: { value: { base: '{colors.primary.900}', _dark: '{colors.primaryDark.900}' } },
        },
        // 预约会议卡片(蓝色调):浅色用 primary.50/200/100/700,深色翻到
        // primaryDark 色阶,保持蓝调的同时明暗互换、对比不倒。
        // (等价于 brand.50/200/100/700,早于 brand 出现,保留不动。)
        scheduledCard: {
          bg: { value: { base: '{colors.primary.50}', _dark: '{colors.primaryDark.75}' } },
          border: {
            value: { base: '{colors.primary.200}', _dark: '{colors.primaryDark.200}' },
          },
          hover: {
            value: { base: '{colors.primary.100}', _dark: '{colors.primaryDark.100}' },
          },
          text: {
            value: { base: '{colors.primary.700}', _dark: '{colors.primaryDark.700}' },
          },
        },
        // 选中态(左栏导航项 / 树节点 / 列表选中行)。
        //
        // 存在的理由:primary.* 是**固定色阶,不随主题翻转**,手写
        // `backgroundColor: 'primary.100'` + `color: 'primary.700'` 在深色下
        // 是一条刺眼的浅蓝亮带;更糟的是文字那侧一旦翻到 primaryDark 而底色
        // 忘了翻,两个浅蓝叠在一起对比度只剩 1.15:1,整行糊掉 —— 这个洞前后
        // 栽了三次(select 弹窗、树选中行、悬停选中项),每次都是「翻了一半」。
        // 用这组 token 就不会漏:一处定义,base/_dark 成对,处处正确。
        //
        // 对比度:深色 #DCE6FB on #1E2A47 ≈ 11.4:1,浅色 #1E4DB3 on #D6E4FF
        // ≈ 6.0:1,两套都过 AA。
        selected: {
          bg: {
            value: { base: '{colors.primary.100}', _dark: '{colors.primaryDark.100}' },
          },
          text: {
            value: { base: '{colors.primary.700}', _dark: '{colors.primaryDark.900}' },
          },
          /** 左边条 / 下划线等「选中标记」——底色差异在深色下天然微弱,实色条不会。 */
          accent: {
            value: { base: '{colors.primary.500}', _dark: '{colors.primaryDark.500}' },
          },
        },
        box: {
          text: { value: '{colors.default.text}' },
          bg: { value: '{colors.greyscale.000}' },
          border: { value: '{colors.greyscale.300}' },
        },
        control: {
          DEFAULT: { value: '{colors.greyscale.100}' },
          hover: { value: '{colors.greyscale.200}' },
          active: { value: '{colors.greyscale.300}' },
          text: { value: '{colors.default.text}' },
          border: { value: '{colors.greyscale.500}' },
          subtle: { value: '{colors.greyscale.400}' },
        },
        // 语义色的「浅底面」三件套:subtle(底) / subtle-text(字) / subtle-border(框)。
        //
        // 四组一律成对给 base/_dark,理由同上面的 brand.*:底色若钉死浅色,配上会
        // 翻转的正文色在深色下就是浅字压浅底。base 全部保持原值,浅色零回归;
        // _dark 取同色系的深底 + 浅字(950 底 / 200 字 / 800 框)。
        //
        // 状态色请一律用这三个键,别写 success.100 / danger.100 那种数字档 ——
        // 那些来自 pandaPreset 的 green/red 原始色阶,**不随主题翻转**;
        // 而 warning 组根本没有数字档(见下,刻意不 spread amber),写 warning.100
        // 会静默产出一条非法声明,背景直接没了(IM 连接状态条「重连中」就栽过)。
        primary: {
          DEFAULT: { value: '{colors.primary.500}' },
          hover: { value: '{colors.primary.600}' },
          active: { value: '{colors.primary.700}' },
          text: { value: '{colors.white}' },
          warm: { value: '{colors.primary.300}' },
          subtle: {
            value: { base: '{colors.primary.100}', _dark: '{colors.primaryDark.100}' },
          },
          'subtle-text': {
            value: { base: '{colors.primary.700}', _dark: '{colors.primaryDark.700}' },
          },
          'subtle-border': {
            value: { base: '{colors.primary.300}', _dark: '{colors.primaryDark.300}' },
          },
        },
        danger: {
          DEFAULT: { value: '{colors.red.600}' },
          hover: { value: '{colors.red.700}' },
          active: { value: '{colors.red.800}' },
          text: { value: '{colors.white}' },
          subtle: { value: { base: '{colors.red.100}', _dark: '{colors.red.950}' } },
          'subtle-text': {
            value: { base: '{colors.red.700}', _dark: '{colors.red.200}' },
          },
          'subtle-border': {
            value: { base: '{colors.red.300}', _dark: '{colors.red.800}' },
          },
          // 注意:这行 spread 把 red.50…950 原样搬进 danger.*,那批**不翻转**。
          // 只在需要固定红(如实心按钮)时用,做浅底面请走上面的 subtle 三件套。
          ...pandaPreset.theme.tokens.colors.red,
        },
        alert: {
          DEFAULT: { value: '{colors.blue.700}' },
          notification: { value: '{colors.red.600}' },
        },
        success: {
          DEFAULT: { value: '{colors.green.700}' },
          hover: { value: '{colors.green.800}' },
          active: { value: '{colors.green.900}' },
          text: { value: '{colors.white}' },
          subtle: { value: { base: '{colors.green.100}', _dark: '{colors.green.950}' } },
          'subtle-text': {
            value: { base: '{colors.green.800}', _dark: '{colors.green.200}' },
          },
          'subtle-border': {
            value: { base: '{colors.green.300}', _dark: '{colors.green.800}' },
          },
          // 同 danger:这批数字档不翻转,浅底面请走 subtle 三件套。
          ...pandaPreset.theme.tokens.colors.green,
        },
        warning: {
          DEFAULT: { value: '{colors.amber.700}' },
          hover: { value: '{colors.amber.800}' },
          active: { value: '{colors.amber.900}' },
          text: { value: '{colors.white}' },
          subtle: { value: { base: '{colors.amber.100}', _dark: '{colors.amber.950}' } },
          'subtle-text': {
            value: { base: '{colors.amber.700}', _dark: '{colors.amber.200}' },
          },
          'subtle-border': {
            value: { base: '{colors.amber.300}', _dark: '{colors.amber.800}' },
          },
          // 刻意**不** spread amber:少一组不翻转的数字档,就少一个 warning.100 那样
          // 的坑。要浅底面就用上面三个键。
        },
        focusRing: { value: 'rgb(74, 121, 199)' },
      },
      shadows: {
        box: { value: '{shadows.sm}' },
        // 浮层层级。深色下黑色投影压在深底上等于不存在 —— 浮层与页面同为
        // greyscale.000(#161616),没有投影就完全看不出边界。
        //
        // 解法照搬 Semi 的 --semi-shadow-elevated:深色改用 1px 白色**内**描边
        // 勾边,再配更重的投影。内描边写在 shadow 值里,调用点零额外属性、
        // 不占布局、不改盒模型(用 border 就得同时补 box-sizing 和几何)。
        //
        // 只给「脱离文档流、浮在内容之上」的面用(弹层/菜单/对话框/抽屉)。
        // 贴附型元素不适用 —— sticky 页头、分段控件、表单控件要的是一条边框
        // 而不是四周一圈环形,那是另一个问题,不在本组范围内。
        overlay: {
          value: {
            base: '0 0 1px rgba(0, 0, 0, 0.16), 0 6px 20px rgba(0, 0, 0, 0.12)',
            _dark:
              'inset 0 0 0 1px rgba(255, 255, 255, 0.1), 0 6px 20px rgba(0, 0, 0, 0.5)',
          },
        },
        modal: {
          value: {
            base: '0 0 1px rgba(0, 0, 0, 0.16), 0 12px 40px rgba(0, 0, 0, 0.2)',
            _dark:
              'inset 0 0 0 1px rgba(255, 255, 255, 0.12), 0 12px 40px rgba(0, 0, 0, 0.6)',
          },
        },
      },
      spacing: {
        boxPadding: {
          DEFAULT: { value: '{spacing.2}' },
          sm: { value: '{spacing.1}' },
          xs: { value: '{spacing.0.5}' },
        },
        boxMargin: {
          xs: { value: '{spacing.0.5}' },
          DEFAULT: { value: '{spacing.1}' },
          lg: { value: '{spacing.2}' },
        },
        paragraph: { value: '{spacing.0.5}' },
        heading: { value: '{spacing.1}' },
        gutter: { value: '{spacing.1}' },
        textfield: { value: '{spacing.1}' },
      },
    }),
    textStyles: defineTextStyles({
      display: {
        value: {
          fontSize: '3rem',
          lineHeight: '2rem',
          fontWeight: 700,
        },
      },
      h1: {
        value: {
          fontSize: '1.5rem',
          lineHeight: '2rem',
          fontWeight: 700,
        },
      },
      h2: {
        value: {
          fontSize: '1.25rem',
          lineHeight: '1.75rem',
          fontWeight: 700,
        },
      },
      h3: {
        value: {
          fontSize: '1.125rem',
          lineHeight: '1.75rem',
        },
      },
      body: {
        value: {
          fontSize: '1rem',
          lineHeight: '1.5',
        },
      },
      sm: {
        value: {
          fontSize: '0.875rem',
          lineHeight: '1.25rem',
        },
      },
      xs: {
        value: {
          fontSize: '0.825rem',
          lineHeight: '1.15rem',
        },
      },
      badge: {
        value: {
          fontSize: '0.75rem',
          lineHeight: '1rem',
        },
      },
    }),
  },
}

export default defineConfig(config)
