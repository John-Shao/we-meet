import {
  Children,
  Fragment,
  forwardRef,
  isValidElement,
  type ChangeEvent,
  type ComponentPropsWithoutRef,
  type ForwardedRef,
  type ReactNode,
} from 'react'

import { css } from '@/styled-system/css'

import { Select, type SelectProps } from './Select'

type NativeSelectProps = ComponentPropsWithoutRef<'select'>

type CompatItem = {
  value: string
  label: ReactNode
  isDisabled?: boolean
}

const optionItems = (
  children: ReactNode,
  groupLabel?: ReactNode
): CompatItem[] =>
  Children.toArray(children).flatMap((child) => {
    if (!isValidElement(child)) return []

    if (child.type === Fragment) {
      const props = child.props as { children?: ReactNode }
      return optionItems(props.children, groupLabel)
    }

    if (child.type === 'optgroup') {
      const props = child.props as { children?: ReactNode; label?: ReactNode }
      return optionItems(props.children, props.label)
    }

    if (child.type !== 'option') return []

    const props = child.props as {
      children?: ReactNode
      disabled?: boolean
      value?: string | number
    }
    const label = groupLabel
      ? `${String(groupLabel)} — ${String(props.children ?? '')}`
      : props.children

    return [
      {
        value: String(props.value ?? ''),
        label,
        isDisabled: props.disabled,
      },
    ]
  })

const rootCls = css({
  minWidth: 0,
  maxWidth: '100%',
})

const menuCls = css({
  maxHeight: '20rem',
  overflowY: 'auto',
})

/**
 * Migration bridge for former native selects. It accepts the native
 * value/onChange/option API but renders the same React Aria Select used by
 * the task-list color picker.
 */
const SelectCompatImpl = (
  {
    children,
    value,
    defaultValue,
    disabled,
    required,
    onChange,
    className: _legacyClassName,
    ...props
  }: NativeSelectProps,
  ref: ForwardedRef<HTMLButtonElement>
) => {
  void _legacyClassName
  const initialKey = Array.isArray(defaultValue)
    ? defaultValue[0]
    : defaultValue
  const selectedKey = Array.isArray(value) ? value[0] : value
  const effectiveKey = selectedKey ?? initialKey
  const items = optionItems(children)
  const selectedLabel = items.find(
    (item) => item.value === String(effectiveKey ?? '')
  )?.label
  const ariaLabel =
    props['aria-label'] ??
    (typeof selectedLabel === 'string' ? selectedLabel : (props.id ?? 'Select'))

  return (
    <Select
      {...(props as unknown as SelectProps<string>)}
      aria-label={ariaLabel}
      className={rootCls}
      items={items}
      selectedKey={effectiveKey == null ? undefined : String(effectiveKey)}
      isDisabled={disabled}
      isRequired={required}
      menuClassName={menuCls}
      triggerRef={ref}
      onSelectionChange={(key) => {
        const target = { value: String(key) } as HTMLSelectElement
        onChange?.({
          target,
          currentTarget: target,
        } as ChangeEvent<HTMLSelectElement>)
      }}
    />
  )
}

export const SelectCompat = forwardRef<HTMLButtonElement, NativeSelectProps>(
  SelectCompatImpl
)

SelectCompat.displayName = 'SelectCompat'
