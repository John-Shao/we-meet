import { useState } from 'react'

import { Dialog, DialogTrigger, Popover } from 'react-aria-components'
import { useTranslation } from 'react-i18next'
import { RiSparkling2Line } from '@remixicon/react'

import { Button } from '@/primitives'
import { css } from '@/styled-system/css'

import { PersonalAIDrawer } from './PersonalAIDrawer'

const fabStyle = css({
  position: 'fixed',
  bottom: '1.5rem',
  right: '1.5rem',
  zIndex: 'fab',
  width: '3.25rem',
  height: '3.25rem',
  borderRadius: '50%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxShadow: '0 6px 18px rgba(0,0,0,0.18)',
  cursor: 'pointer',
})

/**
 * Floating action button anchored bottom-right of the home page. Clicking
 * opens a popover with the cross-meeting AI drawer. Conditional render
 * (only for logged-in users) is the caller's responsibility — this
 * component itself is unconditional.
 */
export const PersonalAIFab = () => {
  const { t } = useTranslation('personal-ai')
  const [isOpen, setIsOpen] = useState(false)

  return (
    <DialogTrigger isOpen={isOpen} onOpenChange={setIsOpen}>
      <Button
        variant="primary"
        aria-label={t('fab.label')}
        tooltip={t('fab.label')}
        className={fabStyle}
        data-attr="personal-ai-fab"
      >
        <RiSparkling2Line />
      </Button>
      <Popover>
        <Dialog
          aria-label={t('title')}
          className={css({ outline: 'none' })}
        >
          <PersonalAIDrawer onClose={() => setIsOpen(false)} />
        </Dialog>
      </Popover>
    </DialogTrigger>
  )
}
