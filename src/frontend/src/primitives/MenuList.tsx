import { ReactNode } from 'react'
import { Menu, MenuProps, MenuItem } from 'react-aria-components'
import { useTranslation } from 'react-i18next'
import { VisuallyHidden } from '@/styled-system/jsx'
import { menuRecipe } from '@/primitives/menuRecipe.ts'
import { cx } from '@/styled-system/css'
import type { RecipeVariantProps } from '@/styled-system/types'

type MenuListItem<T extends string | number> =
  | string
  | { value: T; label: ReactNode; isDisabled?: boolean }

/**
 * render a Button primitive that shows a popover showing a list of pressable items
 */
export const MenuList = <T extends string | number = string>({
  onAction,
  selectedItem,
  items = [],
  variant = 'light',
  ...menuProps
}: {
  onAction: (key: T) => void
  selectedItem?: T
  items: MenuListItem<T>[]
} & MenuProps<unknown> &
  RecipeVariantProps<typeof menuRecipe>) => {
  const { className, ...remainingMenuProps } = menuProps
  const [variantProps] = menuRecipe.splitVariantProps(menuProps)
  const { t } = useTranslation('global')
  const classes = menuRecipe({
    extraPadding: true,
    variant: variant,
    ...variantProps,
  })
  return (
    <Menu
      selectionMode={selectedItem !== undefined ? 'single' : undefined}
      selectedKeys={selectedItem !== undefined ? [selectedItem] : undefined}
      disabledKeys={items.flatMap((item) =>
        typeof item !== 'string' && item.isDisabled ? [item.value] : []
      )}
      className={cx(classes.root, className)}
      {...remainingMenuProps}
    >
      {items.map((item) => {
        const value = typeof item === 'string' ? item : item.value
        const label = typeof item === 'string' ? item : item.label
        const isDisabled = typeof item !== 'string' && item.isDisabled
        return (
          <MenuItem
            className={classes.item}
            key={value}
            id={value as string}
            isDisabled={isDisabled}
            textValue={typeof label === 'string' ? label : undefined}
            onAction={() => {
              onAction(value as T)
            }}
          >
            {({ isSelected }) => (
              <>
                {label}
                {isSelected && (
                  <VisuallyHidden>, {t('selected')}</VisuallyHidden>
                )}
              </>
            )}
          </MenuItem>
        )
      })}
    </Menu>
  )
}
