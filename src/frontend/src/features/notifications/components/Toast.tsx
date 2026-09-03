import { useToast } from '@react-aria/toast'
import { Button } from '@/primitives'
import { RiCloseLine } from '@remixicon/react'
import { ToastState } from '@react-stately/toast'
import { styled } from '@/styled-system/jsx'
import { useRef } from 'react'
import { ToastData } from './ToastProvider'
import type { QueuedToast } from '@react-stately/toast'

export const StyledToastContainer = styled('div', {
  base: {
    margin: 0.5,
    boxShadow: 'overlay',
    backgroundColor: 'surface.raised',
    color: 'text.primary',
    border: '1px solid',
    borderColor: 'border.subtle',
    borderRadius: 'control',
    '&[data-entering]': { animation: 'fade token(durations.slow)' },
    '&[data-exiting]': {
      animation: 'fade token(durations.normal) reverse ease-in',
    },
    width: 'fit-content',
    marginLeft: 'auto',
  },
})

export const StyledToast = styled('div', {
  base: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '1rem',
    padding: '10px',
  },
})

export interface ToastProps {
  key: string
  toast: QueuedToast<ToastData>
  state: ToastState<ToastData>
}

export function Toast({ state, ...props }: Readonly<ToastProps>) {
  const ref = useRef(null)
  const { toastProps, contentProps, closeButtonProps } = useToast(
    props,
    state,
    ref
  )
  return (
    <StyledToastContainer {...toastProps} ref={ref}>
      <StyledToast>
        <div {...contentProps}>{props.toast.content?.message}</div>
        <Button
          square
          size="sm"
          variant="quaternaryText"
          invisible
          {...closeButtonProps}
        >
          <RiCloseLine aria-hidden="true" />
        </Button>
      </StyledToast>
    </StyledToastContainer>
  )
}
