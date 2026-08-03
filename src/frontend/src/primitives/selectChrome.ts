import { css } from '@/styled-system/css'

/**
 * 原生 <select> 统一外观:隐藏系统默认箭头,换成中性灰(#7C7C7C =
 * greyscale.500,深浅色同值,两种主题都成立)自绘下拉箭头,并在右侧留位。
 * 边框/圆角仍由各处自身样式决定,故 cx(本地样式, selectChrome) 即可。
 *
 * **高度**钉在 control.md(32px),与 Input / Select 基元 / Button sm 同档。
 * 原生 select 的盒高本来 = 字号×行高 + 各处自己写的 padding + 边框,而这些各写
 * 各的,实测 12 个调用点散成 21 / 31.5 / 35 / 39 四个值(admin 弹窗那两个既没
 * padding 也没边框,21px 的白框贴在 32px 的 Input 下面)。
 *
 * ⚠️ 钉高之后**必须一起把 padding-block 清掉**(下面那个 `!important`),否则
 * 调用方的 paddingY 会把内容盒挤扁,文字被上下**切掉**:32 −(8+8)− 边框 2 =
 * 14px 内容盒,而 panda reset 给表单控件写了 `font: inherit`,行高随 html 继承
 * 到 1.5 → 0.875rem 的行盒是 21px,21 塞进 14 就是两头各切 3.5px。汉字字面占满
 * em 盒,切得最明显(日历「不重复」上下都缺一截);拉丁文只丢降部(p/g 的尾巴),
 * 所以当初按拉丁文截图验收没看出来。清掉后内容盒 30px > 行盒 21px,浏览器
 * 在元素盒内垂直居中,各调用点原本写多少 paddingY 都不再影响观感。
 * 用 `!important` 而不是普通 `paddingBlock: 0`:这与调用方的 `paddingY` 是同一
 * 属性,cx 叠加时谁赢取决于生成样式表的顺序(见下面 paddingX 那条注意)。
 *
 * ⚠️ 调用方要设左内边距请写 `paddingLeft`,**别写 `paddingX`** —— 那会生成
 * `padding-inline`,与这里的 `paddingRight`(箭头留位)是同属性叠加;cx 叠加同
 * 属性原子类时谁赢取决于生成样式表的顺序而非书写顺序,输掉就把箭头压到文字上。
 *
 * **深色模式下的展开列表**:`appearance: none` 之后 Chromium 不再按
 * color-scheme 推导的系统配色画弹出列表,改用元素自身的 background-color;
 * 而多数调用方只设了边框和字号,背景是 transparent → 列表回落成白底,页面
 * 那套浅色文字落上去整列不可见(实测:admin 会议室的层级时区)。所以这里
 * 必须显式兜底:给 select 一个底色,并**逐条给 option 上色** —— 后者才是
 * 真正决定每一行可读性的,且选择器落在 option 而非 select 上,与调用方设在
 * select 上的背景不会撞。`backgroundColor` 取 greyscale.000,与既有调用方
 * (SelectDialog / Audit filterControl)同值,cx 叠加谁赢都一样。
 *
 * 注:列表的选中高亮仍由系统绘制,靠 root 上的 color-scheme 跟随主题
 * (见 hooks/useApplyTheme)。彻底自定义需换自绘下拉组件,暂不做。
 */
export const selectChrome = css({
  appearance: 'none',
  height: 'control.md',
  backgroundImage: `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%237C7C7C' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 0.625rem center',
  backgroundColor: 'greyscale.000',
  paddingBlock: '0 !important',
  paddingRight: '2rem',
  '& option': {
    backgroundColor: 'greyscale.000',
    color: 'greyscale.900',
  },
})
