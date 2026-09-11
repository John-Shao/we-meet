import {
  useCallback,
  useRef,
  type ChangeEvent,
  type MutableRefObject,
  type Ref,
} from 'react'
import { RiCloseLine, RiSearchLine } from '@remixicon/react'
import { useTranslation } from 'react-i18next'

import { css, cx } from '@/styled-system/css'

import { IconButton } from './IconButton'

/**
 * 全站统一的搜索框 —— 结构就三段,不再由各页面各写各的:
 *
 *   ① 框内**左端**一枚放大镜(位置见 iconCls);
 *   ② 中间输入,占位文案由调用点给(各页面的搜索目标不同);
 *   ③ 有内容时**右端**才出现一枚 ✕(IconButton),点它清空。
 *
 * 尺寸沿用控件契约,不随结构改动:1px 灰描边(greyscale.300,随主题翻转)、
 * 圆角 4px、高 32px(control.md,与同行的 Select / Button 齐平)、13px 字号、
 * 底色 greyscale.000,见下面 inputCls 的注释。
 *
 * 为什么收成一个组件:同一款搜索框原先散着**二十来份**各自为政的实现 ——
 * 通讯录侧栏/成员筛选/我的群组原先是一套「边框画在外层 label 上、图标在左、
 * 圆角 6px」的两层结构,会议室筛选行是「放大镜画在右端」的另一套,十几个弹窗
 * 与三个管理后台页面则各自传一个 Input 基元(无图标、无清除,圆角还是
 * radii.field)。要「一致」就得只有一处定义,否则改了一处另十几处照旧。
 *
 * 焦点态**不在这里**:styles/index.css 的「统一焦点描边」① 会给所有原生 input
 * (含 `type="search"`)加蓝描边 + 柔光环,那条规则未分层,盖得住 panda 的
 * utilities —— 在这里写 `_focus` 等于白写。选 `type="search"` 而不是 text 也是
 * 为了语义(读屏念 searchbox)与 Esc 清空;浏览器自带的那个 ✕ 已由 panda
 * preflight 的 `-webkit-appearance: none` 收掉(@pandacss/generator 的
 * preflight 里 `::-webkit-search-decoration, ::-webkit-search-cancel-button`
 * 一条),右端这块地方才留给我们自己的清除按钮,不会叠出两个 ✕。
 */
export const SearchBox = ({
  value,
  onChange,
  placeholder,
  ariaLabel,
  testId,
  inputRef,
  clearLabel,
  className,
}: {
  value: string
  /** 直接传 setState 即可:回调只给字符串,不给事件。 */
  onChange: (value: string) => void
  placeholder: string
  /** 不给就用占位符当无障碍名。 */
  ariaLabel?: string
  testId?: string
  inputRef?: Ref<HTMLInputElement>
  /** ✕ 的无障碍名(同时是它的 Tooltip);不给就用全局文案「清空搜索」。 */
  clearLabel?: string
  /** 只用来定宽度 / 外边距这类排布,外观不要再从这里改。 */
  className?: string
}) => {
  const { t } = useTranslation('global')
  // 显式写成 `T | null`:React 18 的 `useRef<T>(null)` 返回的 `RefObject` 把
  // `current` 标成只读,清空后那句 `.focus()` 拿得到、下面那句赋值就写不进去。
  const ownInputRef = useRef<HTMLInputElement | null>(null)

  /**
   * 调用点传进来的 ref(多半来自 `useRef`,给 Modal 的 initialFocusRef 用)和我们
   * 自己那份要落在同一个 input 上 —— 清空后要把焦点还回去,离不开自己的那一份。
   * 合并只能走回调 ref:同一时刻只能有一个 `ref` 属性,而对象 ref 的 `.current`
   * 是只读类型(React 18 的 @types),不能直接往调用点那份上写。
   */
  const attachInput = useCallback(
    (node: HTMLInputElement | null) => {
      ownInputRef.current = node
      if (typeof inputRef === 'function') inputRef(node)
      else if (inputRef)
        (inputRef as MutableRefObject<HTMLInputElement | null>).current = node
    },
    [inputRef]
  )

  /**
   * 清空之后**把焦点还给输入框**:✕ 是 label 里的交互内容,点它既不会触发
   * label 对 input 的转发(交互内容会被跳过),浏览器也不会顺手聚焦输入框 ——
   * 不清焦点就落到 body 上,「清掉重打」这个最常见的下一步得先点一下框。
   */
  const clear = () => {
    onChange('')
    ownInputRef.current?.focus()
  }

  return (
    <label className={cx(boxCls, className)}>
      <RiSearchLine size={14} aria-hidden className={iconCls} />
      <input
        ref={attachInput}
        type="search"
        className={inputCls}
        value={value}
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          onChange(event.target.value)
        }
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        data-testid={testId}
      />
      {value !== '' && (
        <IconButton
          // 不能省 `type="button"`:RAC 的 Button 不给 type 时落到 DOM 默认的「提交」。
          // 有几个调用点把搜索框套在 <form> 里(管理后台两个 + 添加外部联系人,回车
          // 即搜),不写这颗 ✕ 就会把「清空」变成「提交一次空搜索」。
          type="button"
          label={clearLabel ?? t('clearSearch')}
          size="icon24"
          onPress={clear}
          className={clearCls}
          data-testid={testId ? `${testId}-clear` : undefined}
        >
          <RiCloseLine size={14} aria-hidden="true" />
        </IconButton>
      )}
    </label>
  )
}

/**
 * 宽度刻意不钉:侧栏与弹窗要撑满、表头筛选是 14rem,各不相同 —— 钉死一个值总有容器
 * 被撑破(窄侧栏、小弹窗、响应式断点)。`display: flex` 而不是 inline-flex,是为了让
 * 不给宽度的调用点按块级撑满,与它们改前的行为一致。
 */
const boxCls = css({
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
})
/**
 * 框本体。
 *
 * 左右两边的内边距都钉死 1.75rem,给框内那两枚图标留位:左边是放大镜、右边是
 * 清除 ✕。不留位时输到末尾的文字会钻到图标底下。右侧**即使没有 ✕ 也留着** ——
 * 那 28px 在有字时才可见(占位文案左对齐,碰不到右边),而留着它,✕ 出现/消失
 * 时框里的文字不会跟着横向挪一下。
 *
 * `paddingBlock: 0` 是因为高度钉了 control.md ——留着纵向内边距会把文字上下切掉
 * (理由同 primitives/selectChrome.ts)。
 */
const inputCls = css({
  flex: 1,
  minWidth: 0,
  fontSize: '0.8125rem',
  height: 'control.md',
  minHeight: 'control.md',
  paddingBlock: 0,
  paddingLeft: '1.75rem',
  paddingRight: '1.75rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: 4,
  backgroundColor: 'greyscale.000',
  color: 'default.text',
})
/**
 * `pointerEvents: 'none'` 不能省:图标浮在 input 之上,否则点它、从它上面起手拖选文字
 * 都会被这层 svg 吃掉,光标也落不到输入框上。它只是「这是个搜索框」的视觉提示,不是
 * 按钮 —— 用它的页面都是边打边筛。
 */
const iconCls = css({
  position: 'absolute',
  left: '0.5rem',
  color: 'greyscale.500',
  pointerEvents: 'none',
})
/**
 * 右端那枚清除 ✕。
 *
 * 用 IconButton 而不是裸 `<button>`:悬停底色、pressed、focus-visible 环、无障碍名
 * 与 Tooltip 都由它一处给出(见 docs/component-system.md「图标按钮」)。
 *
 * 定位用 `top: 50%` + translateY 而不是写死 4px:写死的那个数只在框高正好 32px
 * (control.md)时居中,哪天调用点把框高改了,✕ 就贴到框顶去。`right: 0.25rem`
 * 与 input 的 paddingRight 对齐,✕ 与文字互不遮挡。
 */
const clearCls = css({
  position: 'absolute',
  right: '0.25rem',
  top: '50%',
  transform: 'translateY(-50%)',
})
