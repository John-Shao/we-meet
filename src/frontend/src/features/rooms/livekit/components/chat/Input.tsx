import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'

import { RoomMessageComposer } from '../../../components/RoomMessageComposer'

interface ChatInputProps {
  inputRef: RefObject<HTMLTextAreaElement>
  onSubmit: (text: string) => void
  isSending: boolean
}

export const ChatInput = ({
  inputRef,
  onSubmit,
  isSending,
}: ChatInputProps) => {
  const { t } = useTranslation('rooms', { keyPrefix: 'controls.chat.input' })

  return (
    <RoomMessageComposer
      inputRef={inputRef}
      onSubmit={onSubmit}
      placeholder={t('textArea.placeholder')}
      inputLabel={t('textArea.label')}
      sendLabel={t('button.label')}
      sendingLabel={t('button.label')}
      isSending={isSending}
    />
  )
}
