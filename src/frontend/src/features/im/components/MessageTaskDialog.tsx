import { useMemo, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { Message } from '@jusi/light-im-sdk'
import { RiCalendarLine, RiMessage2Line, RiUser3Line } from '@remixicon/react'

import { Modal, ModalBody, ModalFooter, ModalHeader } from '@/components/Modal'
import { Button, Input, TextArea } from '@/primitives'
import { useUser } from '@/features/auth'
import type { ApiTask, ApiTaskUser } from '@/features/tasks/api/ApiTask'
import { useCreateTask } from '@/features/tasks/api/fetchTasks'
import { TaskAssigneePickerDialog } from '@/features/tasks/components/TaskAssigneePickerDialog'
import { TaskAssigneesDisplay } from '@/features/tasks/components/TaskUserDisplay'
import { css } from '@/styled-system/css'

import { messageTaskDescription, messageTaskSource } from './messageTask'

export const MessageTaskDialog = ({
  message,
  onClose,
  onCreated,
}: {
  message: Message
  onClose: () => void
  onCreated: (task: ApiTask) => void
}) => {
  const { t } = useTranslation('im')
  const { user } = useUser()
  const initialDescription = useMemo(
    () => messageTaskDescription(message) || '',
    [message]
  )
  const titleRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState(initialDescription)
  const [dueDate, setDueDate] = useState('')
  const [assigneePickerOpen, setAssigneePickerOpen] = useState(false)
  const [selectedAssignees, setSelectedAssignees] = useState<
    ApiTaskUser[] | null
  >(null)
  const createMutation = useCreateTask()
  const self = useMemo<ApiTaskUser | null>(
    () =>
      user
        ? {
            id: user.id,
            full_name: user.full_name,
            short_name: null,
            email: user.email,
            avatar_url: user.avatar_url || '',
          }
        : null,
    [user]
  )
  const assignees = selectedAssignees || (self ? [self] : [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const cleanTitle = title.trim()
    if (!cleanTitle || createMutation.isPending) return
    try {
      const saved = await createMutation.mutateAsync({
        title: cleanTitle,
        description: description.trim(),
        assignee_ids:
          assignees.length > 0 ? assignees.map(({ id }) => id) : undefined,
        due_date: dueDate || null,
        source_message: messageTaskSource(message, initialDescription),
      })
      onCreated(saved)
      onClose()
    } catch {
      // Keep the draft open so the user can retry without retyping it.
    }
  }

  return (
    <>
      <Modal
        onClose={onClose}
        ariaLabel={t('messageTask.title')}
        initialFocusRef={titleRef}
        maxWidth="520px"
      >
        <ModalHeader
          title={t('messageTask.title')}
          onClose={onClose}
          closeLabel={t('messageTask.cancel')}
        />
        <form onSubmit={(event) => void submit(event)}>
          <ModalBody maxHeight="65vh">
            <div className={formCss}>
              <label className={fieldCss}>
                <span>{t('messageTask.taskTitle')}</span>
                <Input
                  ref={titleRef}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder={t('messageTask.titlePlaceholder')}
                  maxLength={500}
                  required
                />
              </label>

              <label className={fieldCss}>
                <span>{t('messageTask.description')}</span>
                <TextArea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={5}
                  maxLength={5000}
                />
              </label>

              <div className={sourceCss}>
                <RiMessage2Line size={18} aria-hidden="true" />
                <div>
                  <strong>{t('messageTask.source')}</strong>
                  <p>{initialDescription}</p>
                </div>
              </div>

              <div className={propertyGridCss}>
                <div className={propertyCss}>
                  <RiUser3Line size={18} aria-hidden="true" />
                  <span>{t('messageTask.assignee')}</span>
                  <button
                    type="button"
                    onClick={() => setAssigneePickerOpen(true)}
                  >
                    <TaskAssigneesDisplay users={assignees} />
                  </button>
                </div>
                <label className={propertyCss}>
                  <RiCalendarLine size={18} aria-hidden="true" />
                  <span>{t('messageTask.dueDate')}</span>
                  <input
                    type="date"
                    value={dueDate}
                    onChange={(event) => setDueDate(event.target.value)}
                  />
                </label>
              </div>

              <p className={shareHintCss}>{t('messageTask.shareHint')}</p>
              {createMutation.error && (
                <p role="alert" className={errorCss}>
                  {t('messageTask.createFailed')}
                </p>
              )}
            </div>
          </ModalBody>
          <ModalFooter>
            <Button variant="secondary" onPress={onClose}>
              {t('messageTask.cancel')}
            </Button>
            <Button
              type="submit"
              loading={createMutation.isPending}
              isDisabled={!title.trim() || createMutation.isPending}
            >
              {t('messageTask.create')}
            </Button>
          </ModalFooter>
        </form>
      </Modal>
      {assigneePickerOpen && (
        <TaskAssigneePickerDialog
          initial={assignees}
          onClose={() => setAssigneePickerOpen(false)}
          onConfirm={(nextAssignees) => {
            setSelectedAssignees(nextAssignees)
            setAssigneePickerOpen(false)
          }}
        />
      )}
    </>
  )
}

const formCss = css({ display: 'flex', flexDirection: 'column', gap: 'lg' })

const fieldCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: 'xs',
  '& > span': { color: 'text.secondary', textStyle: 'labelMedium' },
})

const sourceCss = css({
  display: 'flex',
  alignItems: 'flex-start',
  gap: 'sm',
  padding: 'md',
  borderRadius: 'md',
  backgroundColor: 'surface.muted',
  color: 'text.secondary',
  '& > div': { minWidth: 0 },
  '& strong': { color: 'text.primary', textStyle: 'labelMedium' },
  '& p': {
    margin: 0,
    marginTop: 'xs',
    overflow: 'hidden',
    lineClamp: '3',
    whiteSpace: 'pre-wrap',
  },
})

const propertyGridCss = css({
  display: 'grid',
  gridTemplateColumns: { base: '1fr', sm: '1fr 1fr' },
  gap: 'sm',
})

const propertyCss = css({
  display: 'grid',
  gridTemplateColumns: '18px auto minmax(0, 1fr)',
  alignItems: 'center',
  gap: 'sm',
  minHeight: '2.5rem',
  '& > span': { color: 'text.secondary', textStyle: 'labelMedium' },
  '& button, & input': {
    minWidth: 0,
    border: '1px solid token(colors.border.subtle)',
    borderRadius: 'sm',
    backgroundColor: 'surface.default',
    paddingX: 'sm',
    paddingY: 'xs',
    color: 'text.primary',
  },
  '& button': { cursor: 'pointer', textAlign: 'left' },
})

const shareHintCss = css({
  margin: 0,
  color: 'text.secondary',
  textStyle: 'bodySmall',
})
const errorCss = css({
  margin: 0,
  color: 'danger.subtle-text',
  textStyle: 'bodySmall',
})
