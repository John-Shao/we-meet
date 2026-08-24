import { useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { RiAddLine, RiDeleteBinLine } from '@remixicon/react'

import { Modal, ModalCloseButton } from '@/components/Modal'
import { StateHint } from '@/components/StateHint'
import { useUser } from '@/features/auth'
import {
  ContactPicker,
  MemberAvatar,
  type DirectoryMember,
} from '@/features/contacts'
import { Button, Input } from '@/primitives'
import { css } from '@/styled-system/css'

import type { ApiTaskList } from '../api/ApiTask'
import {
  useArchivedTaskLists,
  useDestroyTaskList,
  useRemoveTaskListShare,
  useShareTaskList,
  useTaskListShares,
  useUpdateTaskList,
  useUpdateTaskListShare,
} from '../api/fetchTasks'

const userName = (user: {
  full_name: string | null
  short_name: string | null
  email?: string | null
}) => user.full_name || user.short_name || user.email || '—'

export const TaskListRenameDialog = ({
  taskList,
  onClose,
}: {
  taskList: ApiTaskList
  onClose: () => void
}) => {
  const { t } = useTranslation('tasks')
  const inputRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(taskList.name)
  const mutation = useUpdateTaskList()
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    await mutation.mutateAsync({
      taskListId: taskList.id,
      patch: { name: name.trim() },
    })
    onClose()
  }
  return (
    <Modal
      ariaLabel={t('taskLists.rename')}
      onClose={onClose}
      initialFocusRef={inputRef}
      maxWidth="440px"
    >
      <DialogHeader title={t('taskLists.rename')} onClose={onClose} />
      <form className={formCss} onSubmit={(event) => void submit(event)}>
        <label>
          {t('taskLists.name')}
          <Input
            ref={inputRef}
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {mutation.error && <ErrorText />}
        <DialogActions onClose={onClose} pending={mutation.isPending} />
      </form>
    </Modal>
  )
}

export const TaskListSharingDialog = ({
  taskList,
  onClose,
}: {
  taskList: ApiTaskList
  onClose: () => void
}) => {
  const { t } = useTranslation('tasks')
  const { user: currentUser } = useUser()
  const [pickerOpen, setPickerOpen] = useState(false)
  const {
    data: accesses = [],
    isLoading,
    error,
  } = useTaskListShares(taskList.id)
  const share = useShareTaskList()
  const update = useUpdateTaskListShare()
  const remove = useRemoveTaskListShare()
  const addMember = async (member: DirectoryMember) => {
    await share.mutateAsync({
      taskListId: taskList.id,
      userId: member.id,
      role: 'viewer',
    })
    setPickerOpen(false)
  }
  return (
    <>
      <Modal
        ariaLabel={t('taskLists.shareTitle', { name: taskList.name })}
        onClose={onClose}
        maxWidth="520px"
      >
        <DialogHeader
          title={t('taskLists.shareTitle', { name: taskList.name })}
          onClose={onClose}
        />
        <div className={sharingCss}>
          <Button
            variant="secondary"
            size="action"
            onPress={() => setPickerOpen(true)}
          >
            <RiAddLine size={17} />
            {t('taskLists.addCollaborator')}
          </Button>
          <p className={hintCss}>{t('taskLists.shareHint')}</p>
          {isLoading ? (
            <StateHint loading>{t('loading')}</StateHint>
          ) : error ? (
            <StateHint>{t('error')}</StateHint>
          ) : (
            <ul className={memberListCss}>
              {accesses.map((access) => (
                <li key={access.id}>
                  <MemberAvatar
                    name={userName(access.user)}
                    src={access.user.avatar_url}
                    size="1.75rem"
                  />
                  <span className={memberNameCss}>{userName(access.user)}</span>
                  {access.role === 'owner' ||
                  access.user.id === currentUser?.id ? (
                    <span className={ownerCss}>
                      {t(
                        access.role === 'owner'
                          ? 'taskLists.roles.owner'
                          : `taskLists.roles.${access.role}`
                      )}
                    </span>
                  ) : (
                    <>
                      <select
                        aria-label={t('taskLists.permissionFor', {
                          name: userName(access.user),
                        })}
                        className={roleSelectCss}
                        value={access.role}
                        disabled={update.isPending}
                        onChange={(event) =>
                          update.mutate({
                            taskListId: taskList.id,
                            userId: access.user.id,
                            role: event.target.value as 'viewer' | 'editor',
                          })
                        }
                      >
                        <option value="viewer">
                          {t('taskLists.roles.viewer')}
                        </option>
                        <option value="editor">
                          {t('taskLists.roles.editor')}
                        </option>
                      </select>
                      <Button
                        variant="tertiary"
                        size="icon24"
                        aria-label={t('taskLists.removeCollaborator', {
                          name: userName(access.user),
                        })}
                        isDisabled={remove.isPending}
                        onPress={() =>
                          remove.mutate({
                            taskListId: taskList.id,
                            userId: access.user.id,
                          })
                        }
                      >
                        <RiDeleteBinLine size={16} />
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {(share.error || update.error || remove.error) && <ErrorText />}
        </div>
      </Modal>
      {pickerOpen && (
        <ContactPicker
          title={t('taskLists.addCollaborator')}
          searchPlaceholder={t('taskLists.searchCollaborator')}
          onClose={() => setPickerOpen(false)}
          onSelect={(member) => void addMember(member)}
        />
      )}
    </>
  )
}

export const TaskListDeleteDialog = ({
  taskList,
  onClose,
  onDeleted,
}: {
  taskList: ApiTaskList
  onClose: () => void
  onDeleted: () => void
}) => {
  const { t } = useTranslation('tasks')
  const [deleteUnassigned, setDeleteUnassigned] = useState(false)
  const mutation = useDestroyTaskList()
  const destroy = async () => {
    await mutation.mutateAsync({ taskListId: taskList.id, deleteUnassigned })
    onDeleted()
  }
  return (
    <Modal
      ariaLabel={t('taskLists.deleteTitle')}
      onClose={onClose}
      maxWidth="480px"
    >
      <DialogHeader title={t('taskLists.deleteTitle')} onClose={onClose} />
      <div className={formCss}>
        <p className={messageCss}>
          {t('taskLists.deleteDescription', { name: taskList.name })}
        </p>
        <label className={checkboxCss}>
          <input
            type="checkbox"
            checked={deleteUnassigned}
            onChange={(event) => setDeleteUnassigned(event.target.checked)}
          />
          {t('taskLists.deleteUnassigned')}
        </label>
        {mutation.error && <ErrorText />}
        <div className={actionsCss}>
          <Button variant="secondary" size="action" onPress={onClose}>
            {t('workspace.createCancel')}
          </Button>
          <Button
            variant="primary"
            size="action"
            loading={mutation.isPending}
            onPress={() => void destroy()}
          >
            {t('taskLists.delete')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export const ArchivedTaskListsDialog = ({
  onClose,
}: {
  onClose: () => void
}) => {
  const { t } = useTranslation('tasks')
  const { data = [], isLoading, error } = useArchivedTaskLists()
  const update = useUpdateTaskList()
  return (
    <Modal
      ariaLabel={t('taskLists.archivedTitle')}
      onClose={onClose}
      maxWidth="520px"
    >
      <DialogHeader title={t('taskLists.archivedTitle')} onClose={onClose} />
      <div className={sharingCss}>
        {isLoading ? (
          <StateHint loading>{t('loading')}</StateHint>
        ) : error ? (
          <StateHint>{t('error')}</StateHint>
        ) : data.length === 0 ? (
          <StateHint>{t('taskLists.archivedEmpty')}</StateHint>
        ) : (
          <ul className={archiveListCss}>
            {data.map((taskList) => (
              <li key={taskList.id}>
                <span>{taskList.name}</span>
                {taskList.can_archive && (
                  <Button
                    variant="secondary"
                    size="action"
                    loading={update.isPending}
                    onPress={() =>
                      update.mutate({
                        taskListId: taskList.id,
                        patch: { is_archived: false },
                        archived: true,
                      })
                    }
                  >
                    {t('taskLists.restore')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}

const DialogHeader = ({
  title,
  onClose,
}: {
  title: string
  onClose: () => void
}) => (
  <div className={headerCss}>
    <h2>{title}</h2>
    <ModalCloseButton label={title} onClose={onClose} />
  </div>
)

const DialogActions = ({
  onClose,
  pending,
}: {
  onClose: () => void
  pending: boolean
}) => {
  const { t } = useTranslation('tasks')
  return (
    <div className={actionsCss}>
      <Button variant="secondary" size="action" onPress={onClose}>
        {t('workspace.createCancel')}
      </Button>
      <Button type="submit" size="action" loading={pending}>
        {t('actions.save')}
      </Button>
    </div>
  )
}

const ErrorText = () => {
  const { t } = useTranslation('tasks')
  return <p className={errorCss}>{t('taskLists.actionError')}</p>
}

const headerCss = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '0.75rem 1rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
  '& h2': { margin: 0, fontSize: '1rem' },
})
const formCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
  padding: '1rem',
  fontSize: '0.8125rem',
  '& label:not(:last-child)': {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
  },
})
const sharingCss = css({
  padding: '1rem',
  maxHeight: '60vh',
  overflowY: 'auto',
})
const hintCss = css({
  margin: '0.75rem 0',
  color: 'greyscale.600',
  fontSize: '0.75rem',
})
const memberListCss = css({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  '& li': {
    minHeight: '3rem',
    display: 'flex',
    alignItems: 'center',
    gap: '0.625rem',
    borderBottom: '1px solid token(colors.greyscale.100)',
  },
})
const memberNameCss = css({
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
})
const ownerCss = css({ color: 'greyscale.600', fontSize: '0.75rem' })
const roleSelectCss = css({
  height: '2rem',
  paddingX: '0.5rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '6px',
  backgroundColor: 'greyscale.000',
})
const archiveListCss = css({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  '& li': {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '1rem',
    paddingY: '0.625rem',
    borderBottom: '1px solid token(colors.greyscale.100)',
  },
})
const actionsCss = css({
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.625rem',
})
const messageCss = css({ margin: 0, color: 'greyscale.700', lineHeight: 1.6 })
const checkboxCss = css({
  display: 'flex!',
  flexDirection: 'row!',
  alignItems: 'flex-start',
  gap: '0.5rem',
})
const errorCss = css({
  margin: 0,
  color: 'danger.subtle-text',
  fontSize: '0.75rem',
})
