import { cva, type RecipeVariantProps } from '@/styled-system/css'

/**
 * Compact label recipe for filters, selections, people, and inline metadata.
 * Product code supplies intent rather than rebuilding palette-based styles.
 */
export const chipRecipe = cva({
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    maxWidth: 'full',
    border: '1px solid',
    whiteSpace: 'nowrap',
  },
  variants: {
    tone: {
      neutral: {
        backgroundColor: 'surface.canvas',
        color: 'text.secondary',
        borderColor: 'border.default',
      },
      brand: {
        backgroundColor: 'action.selected.bg',
        color: 'action.selected.text',
        borderColor: 'border.focus',
      },
      danger: {
        backgroundColor: 'status.danger.container',
        color: 'status.danger.container-text',
        borderColor: 'status.danger',
      },
      warning: {
        backgroundColor: 'status.warning.container',
        color: 'status.warning.container-text',
        borderColor: 'status.warning',
      },
      success: {
        backgroundColor: 'status.success.container',
        color: 'status.success.container-text',
        borderColor: 'status.success',
      },
    },
    size: {
      sm: {
        paddingX: 'xs',
        borderRadius: '0.25rem',
        textStyle: 'labelSmall',
      },
      md: {
        paddingX: 'sm',
        paddingY: 'xs',
        borderRadius: 'full',
        textStyle: 'labelMedium',
      },
    },
  },
  defaultVariants: {
    tone: 'neutral',
    size: 'md',
  },
})

export type ChipRecipeProps = RecipeVariantProps<typeof chipRecipe>
