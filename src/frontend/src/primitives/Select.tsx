import { type ReactNode } from 'react'
import { styled, VisuallyHidden } from '@/styled-system/jsx'
import { RemixiconComponentType, RiArrowDropDownLine } from '@remixicon/react'
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
import { css } from '@/styled-system/css'
import type { Placement } from '@react-types/overlays'

const StyledButton = styled(Button, {
  base: {
    width: 'full',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    // 与 Input / Button sm 对齐(见 panda.config 的 sizes.control)。
    // 原先 30px,是这批控件里最矮的一个。内容由上面的 flex 居中。
    height: 'control.md',
    minHeight: 'control.md',
    paddingY: 0.125,
    paddingX: 0.25,
    border: '1px solid',
    borderColor: 'control.border',
    color: 'control.text',
    borderRadius: 4,
    boxShadow: '0 1px 2px rgba(0 0 0 / 0.1)',
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
      borderColor: 'focusRing!',
      boxShadow: 'focusRing!',
    },
    '&[data-pressed]': {
      backgroundColor: 'control.hover',
    },
    // fixme disabled style is being overridden by placeholder one and needs refinement.
    '&[data-disabled]': {
      color: 'default.subtle-text',
      borderColor: 'greyscale.200',
      boxShadow: '0 1px 2px rgba(0 0 0 / 0.02)',
    },
  },
  variants: {
    variant: {
      light: {},
      dark: {
        backgroundColor: 'primaryDark.100',
        fontWeight: 'medium !important',
        color: 'white',
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
      color: 'default.subtle-text',
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

export type SelectProps<T> = Omit<
  RACSelectProps<object>,
  'items' | 'label' | 'errors'
> & {
  iconComponent?: RemixiconComponentType
  label: ReactNode
  items: Array<{ value: T; label: ReactNode }>
  errors?: ReactNode
  placement?: Placement
  variant?: 'light' | 'dark'
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
  menuClassName,
  ...props
}: SelectProps<T>) => {
  const IconComponent = iconComponent
  const { t } = useTranslation('global')
  return (
    <RACSelect {...props}>
      {label}
      <StyledButton variant={variant}>
        {!!IconComponent && (
          <StyledIcon>
            <IconComponent size={18} />
          </StyledIcon>
        )}
        <StyledSelectValue />
        <RiArrowDropDownLine
          aria-hidden="true"
          className={css({ flexShrink: 0 })}
        />
      </StyledButton>
      <StyledPopover placement={placement}>
        <Box size="sm" type="popover" variant={variant}>
          <ListBox className={menuClassName}>
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
