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
        // 预约会议卡片(蓝色调):浅色用 primary.50/200/100/700,深色翻到
        // primaryDark 色阶,保持蓝调的同时明暗互换、对比不倒。
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
        primary: {
          DEFAULT: { value: '{colors.primary.500}' },
          hover: { value: '{colors.primary.600}' },
          active: { value: '{colors.primary.700}' },
          text: { value: '{colors.white}' },
          warm: { value: '{colors.primary.300}' },
          subtle: { value: '{colors.primary.100}' },
          'subtle-text': { value: '{colors.primary.700}' },
        },
        danger: {
          DEFAULT: { value: '{colors.red.600}' },
          hover: { value: '{colors.red.700}' },
          active: { value: '{colors.red.800}' },
          text: { value: '{colors.white}' },
          subtle: { value: '{colors.red.100}' },
          'subtle-text': { value: '{colors.red.700}' },
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
          subtle: { value: '{colors.green.100}' },
          'subtle-text': { value: '{colors.green.800}' },
          ...pandaPreset.theme.tokens.colors.green,
        },
        warning: {
          DEFAULT: { value: '{colors.amber.700}' },
          hover: { value: '{colors.amber.800}' },
          active: { value: '{colors.amber.900}' },
          text: { value: '{colors.white}' },
          subtle: { value: '{colors.amber.100}' },
          'subtle-text': { value: '{colors.amber.700}' },
        },
        focusRing: { value: 'rgb(74, 121, 199)' },
      },
      shadows: {
        box: { value: '{shadows.sm}' },
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
