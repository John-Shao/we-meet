import { cva, cx, type RecipeVariantProps } from '@/styled-system/css'

const badge = cva({
  base: {
    display: 'inline-block',
    paddingY: 'xs',
    paddingX: 'sm',
    border: '1px solid transparent',
    borderRadius: '6',
  },
  variants: {
    tone: {
      brand: {
        backgroundColor: 'action.selected.bg',
        color: 'action.selected.text',
        borderColor: 'border.focus',
      },
      neutral: {
        backgroundColor: 'surface.canvas',
        color: 'text.secondary',
        borderColor: 'border.subtle',
      },
      success: {
        backgroundColor: 'status.success.container',
        color: 'status.success.container-text',
      },
      warning: {
        backgroundColor: 'status.warning.container',
        color: 'status.warning.container-text',
      },
      danger: {
        backgroundColor: 'status.danger.container',
        color: 'status.danger.container-text',
      },
    },
    size: {
      sm: {
        textStyle: 'labelMedium',
      },
      normal: {},
    },
  },
  defaultVariants: {
    tone: 'brand',
    size: 'normal',
  },
})

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> &
  RecipeVariantProps<typeof badge>

export const Badge = ({ className, size, tone, ...props }: BadgeProps) => {
  return <span {...props} className={cx(badge({ size, tone }), className)} />
}
