import { type ReactNode, type Ref } from 'react'
import { styled, VisuallyHidden } from '@/styled-system/jsx'
import type { RemixiconComponentType } from '@remixicon/react'
import {
  Button,
  ListBox,
  ListBoxItem,
  Select as RACSelect,
  SelectProps as RACSelectProps,
  SelectValue,
} from 'react-aria-components'
import { useTranslation } from 'react-i18next'
import { Box } from './Box'
import { StyledPopover } from './Popover'
import { menuRecipe } from '@/primitives/menuRecipe.ts'
import { css, cx } from '@/styled-system/css'
import type { Placement } from '@react-types/overlays'

const StyledButton = styled(Button, {
  base: {
    width: 'full',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    // 与 Input / Button sm 对齐(见 panda.config 的 sizes.control)。
    // 原先 30px,是这批控件里最矮的一个。内容由上面的 flex 居中。
    height: 'controlHeight.compact',
    minHeight: 'controlHeight.compact',
    paddingY: 0,
    // 与「系统设置 → 语言」下拉(selectChrome)同款:文字左起 0.875rem,
    // 右侧箭头距右 0.625rem(space-between 已把文字与箭头隔开)。
    paddingLeft: '0.875rem',
    paddingRight: '0.625rem',
    border: '1px solid',
    borderColor: 'border.default',
    backgroundColor: 'surface.default',
    color: 'text.primary',
    textStyle: 'bodyMedium',
    borderRadius: 'control',
    cursor: 'pointer',
    transition:
      'border-color token(durations.fast) token(easings.standard), background-color token(durations.fast) token(easings.standard)',
    '&[data-hovered]:not([data-disabled])': {
      borderColor: 'border.strong',
    },
    '&[data-focus-visible], &[data-focused]': {
      // 「选择框」归输入类:焦点态与输入框同款 —— 蓝描边 + 柔光环,见
      // styles/index.css 的「统一焦点描边」。原先这里是 2px 焦点环 + offset -1px,
      // 全站独一档;offset 取负正是因为环画在外面会压到同一行的邻居,而
      // box-shadow 光环贴着边框长,天生没这个问题。
      //
      // 连 data-focused 一起认(而不只是键盘态 data-focus-visible):原生 <select>
      // 走 CSS `:focus`,鼠标点开时也亮描边,两种选择框的焦点态得对得上。
      //
      // 三个 `!` 是必需的:index.css 里那条兜底焦点环是**未分层**规则,优先于
      // panda utilities 层的普通声明,不加 `!` 这三行会被它整体盖掉
      // (Checkbox / Radio / Switch 同理)。
      outline: 'none!',
      borderColor: 'border.focus!',
      boxShadow: 'focusRing!',
    },
    '&[data-pressed]': {
      backgroundColor: 'surface.canvas',
    },
    '&[data-disabled]': {
      color: 'text.disabled',
      borderColor: 'border.subtle',
      backgroundColor: 'surface.canvas',
    },
    '&[data-invalid]:not([data-disabled])': {
      borderColor: 'status.danger',
    },
  },
  variants: {
    variant: {
      light: {},
      dark: {
        backgroundColor: 'primaryDark.100',
        fontWeight: 'medium !important',
        color: 'white',
        // 深色舞台(会中设备选择)保留固定灰描边:基类的 greyscale.300 随主题
        // 翻成深灰,压在 primaryDark 蓝底上几乎看不见。
        borderColor: 'border.strong',
        '&[data-pressed]': {
          backgroundColor: 'primaryDark.900',
          color: 'primaryDark.100',
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
    },
  },
  defaultVariants: {
    variant: 'light',
  },
})

const StyledSelectValue = styled(SelectValue, {
  base: {
    textOverflow: 'ellipsis',
    overflow: 'hidden',
    textWrap: 'nowrap',
    '&[data-placeholder]': {
      color: 'text.disabled',
      fontStyle: 'italic',
    },
  },
})

const StyledIcon = styled('div', {
  base: {
    marginRight: '0.35rem',
    flexShrink: 0,
  },
})

// 展开列表与收起控件同为 14px;popover 渲染在 portal 里,不显式给会继承 body 的
// 16px,和上面的 button 对不齐。
const menuListCls = css({ textStyle: 'bodyMedium' })

export type SelectProps<T> = Omit<
  RACSelectProps<object>,
  'items' | 'label' | 'errors'
> & {
  iconComponent?: RemixiconComponentType
  /** Visual label. Omit it for compact filter controls that use aria-label. */
  label?: ReactNode
  items: Array<{ value: T; label: ReactNode; isDisabled?: boolean }>
  errors?: ReactNode
  placement?: Placement
  variant?: 'light' | 'dark'
  triggerRef?: Ref<HTMLButtonElement>
  /** Optional local styling for the expanded option list. */
  menuClassName?: string
}

export const Select = <T extends string | number>({
  label,
  iconComponent,
  items,
  errors,
  placement,
  variant = 'light',
  triggerRef,
  menuClassName,
  ...props
}: SelectProps<T>) => {
  const IconComponent = iconComponent
  const { t } = useTranslation('global')
  return (
    <RACSelect {...props}>
      {label}
      <StyledButton ref={triggerRef} variant={variant}>
        {!!IconComponent && (
          <StyledIcon>
            <IconComponent size={18} />
          </StyledIcon>
        )}
        <StyledSelectValue />
        {/* currentColor keeps the arrow aligned with enabled/disabled text semantics. */}
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={css({ flexShrink: 0 })}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </StyledButton>
      <StyledPopover placement={placement}>
        <Box size="sm" type="popover" variant={variant}>
          <ListBox className={cx(menuListCls, menuClassName)}>
            {items.map((item) => (
              <ListBoxItem
                className={
                  menuRecipe({
                    extraPadding: true,
                    variant: variant,
                  }).item
                }
                id={item.value}
                key={item.value}
                isDisabled={item.isDisabled}
                textValue={
                  typeof item.label === 'string' ? item.label : undefined
                }
              >
                {({ isSelected }) => (
                  <>
                    {item.label}
                    {isSelected && (
                      <VisuallyHidden>, {t('selected')}</VisuallyHidden>
                    )}
                  </>
                )}
              </ListBoxItem>
            ))}
          </ListBox>
        </Box>
      </StyledPopover>
      {errors}
    </RACSelect>
  )
}
