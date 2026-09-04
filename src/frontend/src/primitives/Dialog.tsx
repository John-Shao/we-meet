import { styled } from '@/styled-system/jsx'
import { RiCloseLine } from '@remixicon/react'
import { t } from 'i18next'
import {
  Dialog as RACDialog,
  ModalOverlay,
  Modal,
  type DialogProps as RACDialogProps,
  Heading,
} from 'react-aria-components'
import { Div, IconButton, Box, VerticallyOffCenter } from '@/primitives'
import { text } from './Text'
import { MutableRefObject } from 'react'
import { css } from '@/styled-system/css'

const StyledModalOverlay = styled(ModalOverlay, {
  base: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 'modal',
    '&[data-entering]': { animation: 'fade token(durations.slow)' },
    '&[data-exiting]': {
      animation: 'fade token(durations.normal) reverse ease-in',
    },
  },
})

// disabled pointerEvents on the stuff surrounding the overlay is there so that clicking on the overlay to close the modal still works
const StyledModal = styled(Modal, {
  base: {
    width: 'full',
    height: 'full',
    pointerEvents: 'none',
    '--origin': 'translateY(32px)',
    '&[data-entering]': { animation: 'slide 300ms' },
  },
})

const StyledRACDialog = styled(RACDialog, {
  base: {
    width: 'full',
    height: 'full',
    pointerEvents: 'none',
  },
})

const ModalContent = styled('div', {
  base: {
    margin: 'auto',
  },
  variants: {
    size: {
      full: {
        width: 'fit-content',
        maxWidth: '100%',
      },
      large: {
        width: '100%',
        xl: { width: '1200px' },
      },
    },
  },
})

export type DialogProps = RACDialogProps & {
  title?: string
  onClose?: () => void
  /**
   * use the Dialog as a controlled component
   */
  isOpen?: boolean
  /**
   * use the Dialog as a controlled component:
   * this is called when isOpen should be updated
   * after user interaction
   */
  onOpenChange?: (isOpen: boolean) => void
  /**
   * 外框宽度档位:
   * - 不传   → 定宽 30rem(内容区 27rem),适合普通表单;
   * - 'alert' → 定宽 24rem;
   * - 'flex' → 宽度跟着内容走。**内容宽于 27rem 的对话框必须用这一档**,
   *   否则超出的部分既不撑框也不裁剪,会整片露到白框外面(见管理台
   *   「授予角色」的历史问题)。
   */
  type?: 'flex' | 'alert'
  innerRef?: MutableRefObject<HTMLDivElement | null>
  size?: 'full' | 'large'
}

export const Dialog = ({
  title,
  children,
  onClose,
  isOpen,
  onOpenChange,
  innerRef,
  size = 'full',
  // 宽度档位是我们自己的 prop,不能跟着 spread 落到 RAC 的 <div> 上
  // (会渲染出一个无意义的 type="flex" 属性)。
  type,
  ...dialogProps
}: DialogProps) => {
  const isAlert = dialogProps['role'] === 'alertdialog'
  const boxType =
    type === 'alert' ? 'alert' : type === 'flex' ? 'modal' : 'dialog'
  return (
    <StyledModalOverlay
      isKeyboardDismissDisabled={isAlert}
      isDismissable={!isAlert}
      isOpen={isOpen}
      onOpenChange={(isOpen) => {
        if (onOpenChange) {
          onOpenChange(isOpen)
        }
        if (!isOpen && onClose) {
          onClose()
        }
      }}
    >
      <StyledModal>
        <StyledRACDialog {...dialogProps}>
          {({ close }) => (
            <VerticallyOffCenter>
              <ModalContent size={size}>
                <Div margin="1rem" pointerEvents="auto">
                  <Box
                    size="sm"
                    type={boxType}
                    ref={innerRef}
                    className={css({
                      padding: '1.5rem',
                    })}
                  >
                    {!!title && (
                      <Heading
                        slot="title"
                        level={1}
                        className={text({ variant: 'h1' })}
                      >
                        {title}
                      </Heading>
                    )}
                    {typeof children === 'function'
                      ? children({ close })
                      : children}
                    {!isAlert && (
                      <Div position="absolute" top="5" right="5">
                        <IconButton
                          label={t('closeDialog')}
                          size="icon28"
                          onPress={() => close()}
                        >
                          <RiCloseLine size={20} aria-hidden="true" />
                        </IconButton>
                      </Div>
                    )}
                  </Box>
                </Div>
              </ModalContent>
            </VerticallyOffCenter>
          )}
        </StyledRACDialog>
      </StyledModal>
    </StyledModalOverlay>
  )
}
