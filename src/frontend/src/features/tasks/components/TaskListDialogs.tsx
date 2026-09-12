import { useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { RiAddLine, RiDeleteBinLine } from '@remixicon/react'

import { Modal, ModalCloseButton } from '@/components/Modal'
import { useConfirm } from '@/components/ConfirmProvider'
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
  useDestroyTaskList,
  useTaskListDeletionImpact,
  useTransferTaskList,
  useRecoverableTaskLists,
  useTakeoverTaskList,
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
    try {
      await mutation.mutateAsync({
        taskListId: taskList.id,
        patch: { name: name.trim() },
      })
      onClose()
    } catch {
      // Keep the draft and display the mutation error for retry.
    }
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
  const { confirm } = useConfirm()
  const transfer = useTransferTaskList()
  const transferTo = async (user: {
    id: string
    full_name: string | null
    short_name: string | null
  }) => {
    if (
      !(await confirm({
        title: t('taskLists.transfer'),
        message: t('taskLists.transferConfirm', { name: userName(user) }),
        confirmLabel: t('taskLists.transfer'),
        danger: true,
      }))
    )
      return
    try {
      await transfer.mutateAsync({ taskListId: taskList.id, userId: user.id })
      onClose()
    } catch {
      /* Inline error retains the dialog. */
    }
  }
  const share = useShareTaskList()
  const update = useUpdateTaskListShare()
  const remove = useRemoveTaskListShare()
  const busy =
    share.isPending ||
    update.isPending ||
    remove.isPending ||
    transfer.isPending
  const confirmAccessChange = (user: Parameters<typeof userName>[0]) =>
    confirm({
      title: t('taskLists.share'),
      message: t('taskLists.revokeConfirm', { name: userName(user) }),
      confirmLabel: t('actions.save'),
    })
  const addMember = async (member: DirectoryMember) => {
    try {
      await share.mutateAsync({
        taskListId: taskList.id,
        userId: member.id,
        role: 'viewer',
      })
      setPickerOpen(false)
    } catch {
      // Keep the picker open so the user can retry; the mutation error is
      // rendered by the share dialog.
    }
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
            isDisabled={busy}
            onPress={() => setPickerOpen(true)}
          >
            <RiAddLine size={17} />
            {t('taskLists.addCollaborator')}
          </Button>
          <p className={hintCss}>{t('taskLists.shareHint')}</p>
          {isLoading ? (
            <StateHint state="loading">{t('loading')}</StateHint>
          ) : error ? (
            <StateHint state="error">{t('error')}</StateHint>
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
                      <Button
                        size="dense"
                        variant="secondaryText"
                        isDisabled={busy}
                        onPress={() => void transferTo(access.user)}
                      >
                        {t('taskLists.transfer')}
                      </Button>
                      <select
                        aria-label={t('taskLists.permissionFor', {
                          name: userName(access.user),
                        })}
                        className={roleSelectCss}
                        value={access.role}
                        disabled={busy}
                        onChange={async (event) => {
                          const role = event.target.value as 'viewer' | 'editor'
                          if (
                            role === 'viewer' &&
                            !(await confirmAccessChange(access.user))
                          )
                            return
                          update.mutate({
                            taskListId: taskList.id,
                            userId: access.user.id,
                            role,
                          })
                        }}
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
                        isDisabled={busy}
                        onPress={async () => {
                          if (!(await confirmAccessChange(access.user))) return
                          remove.mutate({
                            taskListId: taskList.id,
                            userId: access.user.id,
                          })
                        }}
                      >
                        <RiDeleteBinLine size={16} />
                      </Button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {(share.error || update.error || remove.error || transfer.error) && (
            <ErrorText />
          )}
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
  const [confirmedToken, setConfirmedToken] = useState<string>()
  const impact = useTaskListDeletionImpact(taskList.id)
  const mutation = useDestroyTaskList()
  const destroy = async () => {
    if (
      mutation.isPending ||
      (deleteUnassigned &&
        (!impact.data ||
          impact.isFetching ||
          impact.isError ||
          confirmedToken !== impact.data.token))
    )
      return
    try {
      await mutation.mutateAsync({
        taskListId: taskList.id,
        deleteUnassigned,
        confirmationToken: confirmedToken,
      })
      onDeleted()
    } catch {
      setDeleteUnassigned(false)
      setConfirmedToken(undefined)
      void impact.refetch()
    }
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
            disabled={
              !impact.data ||
              impact.isFetching ||
              impact.isError ||
              mutation.isPending ||
              impact.data.count === 0
            }
            onChange={(event) => {
              setDeleteUnassigned(event.target.checked)
              setConfirmedToken(impact.data?.token)
            }}
          />
          {t('taskLists.deleteUnassigned')}
        </label>
        {impact.isLoading && (
          <StateHint state="loading">{t('loading')}</StateHint>
        )}
        {impact.isError && (
          <StateHint
            state="error"
            action={
              <Button onPress={() => void impact.refetch()}>
                {t('workspace.retry')}
              </Button>
            }
          >
            {t('error')}
          </StateHint>
        )}
        {impact.data && (
          <div aria-live="polite">
            <p>{t('taskLists.deleteImpact', { count: impact.data.count })}</p>
            <ul className={impactListCss}>
              {impact.data.tasks.map((task) => (
                <li key={task.id}>{task.title}</li>
              ))}
            </ul>
            {impact.data.count > 100 && <p>{t('taskLists.previewLimit')}</p>}
          </div>
        )}
        {deleteUnassigned && <p>{t('taskLists.deleteUnassignedWarning')}</p>}
        {mutation.error && <ErrorText />}
        <div className={actionsCss}>
          <Button variant="secondary" size="action" onPress={onClose}>
            {t('workspace.createCancel')}
          </Button>
          <Button
            variant="danger"
            size="action"
            loading={mutation.isPending}
            isDisabled={
              deleteUnassigned &&
              (!impact.data ||
                impact.isFetching ||
                impact.isError ||
                confirmedToken !== impact.data.token)
            }
            onPress={() => void destroy()}
          >
            {t('taskLists.delete')}
          </Button>
        </div>
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

const impactListCss = css({
  maxHeight: '12rem',
  overflowY: 'auto',
  overflowWrap: 'anywhere',
  paddingInlineStart: '1.25rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '6px',
  paddingBlock: '0.5rem',
})

const recoveryRowCss = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '1rem',
  paddingBlock: '0.75rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
  '& span': { minWidth: 0, overflowWrap: 'anywhere' },
  '& button': { flexShrink: 0 },
})

export const TaskListRecoveryDialog = ({
  onClose,
}: {
  onClose: () => void
}) => {
  const { t } = useTranslation('tasks')
  const { confirm } = useConfirm()
  const lists = useRecoverableTaskLists()
  const takeover = useTakeoverTaskList()
  const recover = async (list: { id: string; name: string }) => {
    if (
      !(await confirm({
        title: t('taskLists.recover'),
        message: t('taskLists.recoverConfirm', { name: list.name }),
        confirmLabel: t('taskLists.recover'),
        danger: true,
      }))
    )
      return
    try {
      await takeover.mutateAsync(list.id)
    } catch {
      /* Keep recovery available for retry. */
    }
  }
  return (
    <Modal
      onClose={onClose}
      ariaLabel={t('taskLists.recover')}
      maxWidth="560px"
    >
      <DialogHeader title={t('taskLists.recover')} onClose={onClose} />
      <div className={formCss}>
        <p>{t('taskLists.recoverHint')}</p>
        {lists.isLoading && (
          <StateHint state="loading">{t('loading')}</StateHint>
        )}
        {lists.isError && (
          <StateHint
            state="error"
            action={
              <Button onPress={() => void lists.refetch()}>
                {t('workspace.retry')}
              </Button>
            }
          >
            {t('error')}
          </StateHint>
        )}
        {takeover.error && <ErrorText />}
        {lists.data?.length === 0 && <p>{t('taskLists.recoverEmpty')}</p>}
        {lists.data?.map((list) => (
          <div key={list.id} className={recoveryRowCss}>
            <span>{list.name}</span>
            <Button
              isDisabled={takeover.isPending}
              onPress={() => void recover(list)}
            >
              {t('taskLists.recover')}
            </Button>
          </div>
        ))}
      </div>
    </Modal>
  )
}
