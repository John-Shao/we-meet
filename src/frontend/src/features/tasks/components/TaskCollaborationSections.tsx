import {
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  RiDeleteBinLine,
  RiDownloadLine,
  RiFile2Fill,
  RiFileExcel2Fill,
  RiFilePdf2Fill,
  RiFilePpt2Fill,
  RiFileTextFill,
  RiFileWord2Fill,
  RiFileZipFill,
  RiImage2Fill,
  RiSendPlane2Fill,
} from '@remixicon/react'

import { useConfirm } from '@/components/ConfirmProvider'
import { Button, TextArea } from '@/primitives'
import { css } from '@/styled-system/css'

import {
  useCreateTaskAttachment,
  useCreateTaskComment,
  useDeleteTaskAttachment,
  useTaskActivities,
  useTaskAttachments,
  useTaskComments,
} from '../api/fetchTasks'
import { taskDisplayName } from '../taskUi'
import { taskActivityMessage } from '../taskActivityMessage'
import {
  TaskAttachmentListSkeleton,
  TaskCommentListSkeleton,
  TaskHistoryListSkeleton,
} from './TaskSkeletons'
import { TaskUserAvatar } from './TaskUserDisplay'

export const TaskCommentsSection = ({
  taskId,
  sharedVia,
  readOnly = false,
}: {
  taskId: string
  sharedVia?: string
  readOnly?: boolean
}) => {
  const { t, i18n } = useTranslation('tasks')
  const [content, setContent] = useState('')
  const { data, isLoading, error } = useTaskComments(taskId, sharedVia)
  const createMutation = useCreateTaskComment()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (createMutation.isPending) return
    if (!content.trim()) return
    try {
      await createMutation.mutateAsync({ taskId, content: content.trim() })
      setContent('')
    } catch {
      // Keep the draft available for retry.
    }
  }

  return (
    <section aria-label={t('comments.title')} className={sectionCss}>
      <AsyncState
        loading={isLoading}
        error={Boolean(error)}
        empty={!data?.length}
        loadingText={t('comments.loading')}
        loadingContent={
          <TaskCommentListSkeleton label={t('comments.loading')} />
        }
        errorText={t('comments.error')}
        emptyText={t('comments.empty')}
      >
        <ul className={listCss}>
          {data?.map((comment) => (
            <li key={comment.id} className={commentItemCss}>
              <TaskUserAvatar user={comment.author} size="2rem" />
              <div className={commentContentCss}>
                <div className={commentHeaderCss}>
                  <span className={commentAuthorCss}>
                    {taskDisplayName(comment.author)}
                  </span>
                  <time className={metaCss} dateTime={comment.created_at}>
                    {new Intl.DateTimeFormat(i18n.language, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(comment.created_at))}
                  </time>
                </div>
                <p className={commentBubbleCss} data-comment-bubble>
                  {comment.content}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </AsyncState>
      {!readOnly && (
        <form
          onSubmit={(event) => void submit(event)}
          className={commentFormCss}
        >
          <div className={commentComposerCss}>
            <TextArea
              aria-label={t('comments.inputLabel')}
              className={commentComposerInputCss}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }
              }}
              placeholder={t('comments.placeholder')}
              maxLength={2000}
              rows={2}
            />
            <Button
              type="submit"
              size="icon32"
              variant="quaternaryText"
              className={commentSendCss}
              icon={<RiSendPlane2Fill size={18} aria-hidden="true" />}
              aria-label={t('comments.submit')}
              tooltip={t('comments.submit')}
              loading={createMutation.isPending}
              isDisabled={createMutation.isPending || !content.trim()}
            />
          </div>
          {createMutation.error && (
            <p role="alert" className={errorCss}>
              {t('comments.postError')}
            </p>
          )}
        </form>
      )}
    </section>
  )
}

export const TaskAttachmentsSection = ({
  taskId,
  sharedVia,
  readOnly = false,
}: {
  taskId: string
  sharedVia?: string
  readOnly?: boolean
}) => {
  const { t, i18n } = useTranslation('tasks')
  const { confirm } = useConfirm()
  const inputRef = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState(0)
  const { data, isLoading, error } = useTaskAttachments(taskId, sharedVia)
  const createMutation = useCreateTaskAttachment()
  const deleteMutation = useDeleteTaskAttachment()

  const selectFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    setProgress(0)
    try {
      await createMutation.mutateAsync({
        taskId,
        file,
        onProgress: setProgress,
      })
    } catch {
      // Mutation error is shown below.
    }
  }

  const remove = async (attachmentId: string) => {
    if (
      !(await confirm({
        message: t('attachments.removeConfirm'),
        danger: true,
      }))
    )
      return
    await deleteMutation.mutateAsync({ taskId, attachmentId }).catch(() => {})
  }

  const formatSize = (size: number | null) => {
    if (size === null) return t('attachments.unknownSize')
    if (size < 1024) return `${size} B`
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
    return `${(size / (1024 * 1024)).toFixed(1)} MB`
  }

  return (
    <section
      aria-label={t('attachments.title')}
      className={attachmentSectionCss}
    >
      <input
        ref={inputRef}
        type="file"
        className={css({ display: 'none' })}
        accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.jpeg,.jpg,.png,.gif,.webp,.zip"
        onChange={(event) => void selectFile(event)}
      />
      {!readOnly && (
        <Button
          className={attachmentUploadActionCss}
          variant="quaternaryText"
          size="dense"
          aria-label={t('attachments.upload')}
          isDisabled={createMutation.isPending}
          onPress={() => inputRef.current?.click()}
        >
          {createMutation.isPending
            ? t('attachments.uploading', { progress })
            : t('actions.upload')}
        </Button>
      )}
      {(createMutation.error || deleteMutation.error) && (
        <p role="alert" className={errorCss}>
          {createMutation.error
            ? t('attachments.uploadError')
            : t('attachments.removeError')}
        </p>
      )}
      <AsyncState
        loading={isLoading}
        error={Boolean(error)}
        empty={!data?.length}
        loadingText={t('attachments.loading')}
        loadingContent={
          <TaskAttachmentListSkeleton label={t('attachments.loading')} />
        }
        errorText={t('attachments.error')}
        emptyText={t('attachments.empty')}
      >
        <ul className={attachmentListCss} data-attachment-list>
          {data?.map((attachment) => (
            <li key={attachment.id} className={attachmentItemCss}>
              <TaskAttachmentTypeIcon
                filename={attachment.filename}
                mimetype={attachment.mimetype}
              />
              <div className={attachmentInfoCss}>
                <span className={attachmentNameCss}>{attachment.filename}</span>
                <p className={metaCss}>
                  {t('attachments.meta', {
                    size: formatSize(attachment.size),
                    date: new Intl.DateTimeFormat(i18n.language, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    }).format(new Date(attachment.created_at)),
                  })}
                </p>
              </div>
              <div className={attachmentActionsCss} data-attachment-actions>
                <a
                  href={attachment.url}
                  download={attachment.filename}
                  className={attachmentActionCss}
                  aria-label={t('attachments.download')}
                  title={t('attachments.download')}
                >
                  <RiDownloadLine size={17} aria-hidden="true" />
                </a>
                {!readOnly && (
                  <button
                    type="button"
                    className={attachmentDeleteActionCss}
                    aria-label={t('attachments.remove')}
                    title={t('attachments.remove')}
                    disabled={deleteMutation.isPending}
                    onClick={() => void remove(attachment.id)}
                  >
                    <RiDeleteBinLine size={17} aria-hidden="true" />
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </AsyncState>
    </section>
  )
}

type AttachmentFileKind =
  | 'pdf'
  | 'word'
  | 'excel'
  | 'powerpoint'
  | 'image'
  | 'archive'
  | 'text'
  | 'file'

const attachmentFileKind = (
  filename: string,
  mimetype: string | null
): AttachmentFileKind => {
  const mime = mimetype?.toLowerCase() || ''
  const extension = filename.split('.').pop()?.toLowerCase() || ''

  if (mime.includes('pdf') || extension === 'pdf') return 'pdf'
  if (
    mime.includes('wordprocessingml') ||
    mime.includes('msword') ||
    ['doc', 'docx'].includes(extension)
  )
    return 'word'
  if (
    mime.includes('spreadsheetml') ||
    mime.includes('ms-excel') ||
    ['xls', 'xlsx', 'csv'].includes(extension)
  )
    return 'excel'
  if (
    mime.includes('presentationml') ||
    mime.includes('ms-powerpoint') ||
    ['ppt', 'pptx'].includes(extension)
  )
    return 'powerpoint'
  if (
    mime.startsWith('image/') ||
    ['jpeg', 'jpg', 'png', 'gif', 'webp'].includes(extension)
  )
    return 'image'
  if (mime.includes('zip') || extension === 'zip') return 'archive'
  if (mime.startsWith('text/') || extension === 'txt') return 'text'
  return 'file'
}

const TaskAttachmentTypeIcon = ({
  filename,
  mimetype,
}: {
  filename: string
  mimetype: string | null
}) => {
  const kind = attachmentFileKind(filename, mimetype)
  const icon =
    kind === 'pdf' ? (
      <RiFilePdf2Fill size={32} />
    ) : kind === 'word' ? (
      <RiFileWord2Fill size={32} />
    ) : kind === 'excel' ? (
      <RiFileExcel2Fill size={32} />
    ) : kind === 'powerpoint' ? (
      <RiFilePpt2Fill size={32} />
    ) : kind === 'image' ? (
      <RiImage2Fill size={32} />
    ) : kind === 'archive' ? (
      <RiFileZipFill size={32} />
    ) : kind === 'text' ? (
      <RiFileTextFill size={32} />
    ) : (
      <RiFile2Fill size={32} />
    )

  return (
    <span
      className={attachmentTypeIconCss}
      data-file-kind={kind}
      aria-hidden="true"
    >
      {icon}
    </span>
  )
}

export const TaskHistorySection = ({
  taskId,
  sharedVia,
}: {
  taskId: string
  sharedVia?: string
}) => {
  const { t, i18n } = useTranslation('tasks')
  const { data, isLoading, error } = useTaskActivities(taskId, sharedVia)
  return (
    <section aria-label={t('history.title')} className={sectionCss}>
      <AsyncState
        loading={isLoading}
        error={Boolean(error)}
        empty={!data?.length}
        loadingText={t('history.loading')}
        loadingContent={
          <TaskHistoryListSkeleton label={t('history.loading')} />
        }
        errorText={t('history.error')}
        emptyText={t('history.empty')}
      >
        <ol className={timelineCss}>
          {data?.map((activity) => (
            <li key={activity.id} className={timelineItemCss}>
              <div className={userMetaCss}>
                <TaskUserAvatar user={activity.actor} size="1.25rem" />
                <p className={bodyCss}>{taskActivityMessage(activity, t)}</p>
              </div>
              <time className={metaCss} dateTime={activity.created_at}>
                {new Intl.DateTimeFormat(i18n.language, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(new Date(activity.created_at))}
              </time>
            </li>
          ))}
        </ol>
      </AsyncState>
    </section>
  )
}

const AsyncState = ({
  loading,
  error,
  empty,
  loadingText,
  loadingContent,
  errorText,
  emptyText,
  children,
}: {
  loading: boolean
  error: boolean
  empty: boolean
  loadingText: string
  loadingContent?: ReactNode
  errorText: string
  emptyText: string
  children: ReactNode
}) => {
  if (loading) return loadingContent || <p className={hintCss}>{loadingText}</p>
  if (error) return <p className={errorCss}>{errorText}</p>
  if (empty) return <p className={hintCss}>{emptyText}</p>
  return children
}

const sectionCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
})
const attachmentSectionCss = css({
  width: '100%',
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '0.5rem',
})
const attachmentUploadActionCss = css({
  alignSelf: 'flex-end',
})
const commentFormCss = css({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
})
const commentComposerCss = css({
  display: 'flex',
  alignItems: 'flex-end',
  gap: '0.25rem',
  padding: '0.25rem',
  border: '1px solid token(colors.greyscale.300)',
  borderRadius: '0.5rem',
  backgroundColor: 'greyscale.000',
  transition: 'border-color 120ms ease, box-shadow 120ms ease',
  _focusWithin: {
    borderColor: 'primary.500',
    boxShadow: '0 0 0 3px token(colors.primary.100)',
  },
})
const commentComposerInputCss = css({
  minWidth: 0,
  minHeight: '2.5rem',
  maxHeight: '7rem',
  flex: 1,
  paddingX: '0.625rem',
  paddingY: '0.5rem',
  borderColor: 'transparent!',
  borderRadius: '0.25rem',
  backgroundColor: 'transparent',
  boxShadow: 'none!',
  fontSize: '0.875rem',
  lineHeight: '1.375rem',
  resize: 'none',
  _focus: {
    borderColor: 'transparent!',
    boxShadow: 'none!',
  },
})
const commentSendCss = css({
  flexShrink: 0,
  marginBottom: '0.25rem',
  color: 'primary.600',
})
const listCss = css({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.625rem',
})
const attachmentListCss = css({
  width: '100%',
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
})
const attachmentItemCss = css({
  width: '100%',
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.5rem',
  padding: '0.625rem 0.75rem',
  border: '1px solid token(colors.greyscale.200)',
  borderRadius: '8px',
  backgroundColor: 'transparent',
  color: 'default.text',
  transition: 'border-color 120ms ease, background-color 120ms ease',
  _hover: {
    borderColor: 'greyscale.300',
    backgroundColor: 'greyscale.50',
    '& [data-attachment-actions]': {
      opacity: 1,
      pointerEvents: 'auto',
    },
  },
  _focusWithin: {
    borderColor: 'primary.400',
    backgroundColor: 'greyscale.50',
    '& [data-attachment-actions]': {
      opacity: 1,
      pointerEvents: 'auto',
    },
  },
})
const attachmentTypeIconCss = css({
  width: '2.5rem',
  minHeight: '2.5rem',
  alignSelf: 'stretch',
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'greyscale.500',
  '&[data-file-kind="pdf"]': { color: 'danger.500' },
  '&[data-file-kind="word"]': { color: 'primary.600' },
  '&[data-file-kind="excel"]': { color: 'success.600' },
  '&[data-file-kind="powerpoint"]': { color: 'amber.600' },
  '&[data-file-kind="image"]': { color: 'purple.500' },
  '&[data-file-kind="archive"]': { color: 'amber.500' },
})
const attachmentInfoCss = css({
  minWidth: 0,
  display: 'flex',
  flex: 1,
  flexDirection: 'column',
  gap: '0.25rem',
})
const attachmentNameCss = css({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: '0.8125rem',
  fontWeight: '400',
})
const attachmentActionsCss = css({
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.125rem',
  opacity: 0,
  pointerEvents: 'none',
  transition: 'opacity 120ms ease',
  '@media (hover: none)': {
    opacity: 1,
    pointerEvents: 'auto',
  },
})
const attachmentActionCss = css({
  width: '1.75rem',
  height: '1.75rem',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  border: 0,
  borderRadius: '6px',
  backgroundColor: 'transparent',
  color: 'greyscale.600',
  cursor: 'pointer',
  _hover: { backgroundColor: 'greyscale.100', color: 'greyscale.900' },
  _focusVisible: {
    outline: '2px solid token(colors.primary.400)',
    outlineOffset: '1px',
  },
})
const attachmentDeleteActionCss = css({
  width: '1.75rem',
  height: '1.75rem',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  border: 0,
  borderRadius: '6px',
  backgroundColor: 'transparent',
  color: 'greyscale.600',
  cursor: 'pointer',
  _hover: { backgroundColor: 'danger.50', color: 'danger.600' },
  _focusVisible: {
    outline: '2px solid token(colors.danger.400)',
    outlineOffset: '1px',
  },
  _disabled: { cursor: 'not-allowed', opacity: 0.45 },
})
const commentItemCss = css({
  display: 'flex',
  alignItems: 'flex-start',
  gap: '0.5rem',
})
const commentContentCss = css({
  minWidth: 0,
  maxWidth: 'calc(100% - 2.5rem)',
  display: 'flex',
  flex: 1,
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '0.25rem',
})
const commentHeaderCss = css({
  minWidth: 0,
  maxWidth: '100%',
  display: 'flex',
  alignItems: 'baseline',
  gap: '0.5rem',
})
const commentAuthorCss = css({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'greyscale.700',
  fontSize: '0.75rem',
  fontWeight: '500',
})
const commentBubbleCss = css({
  maxWidth: '100%',
  margin: 0,
  paddingX: '0.75rem',
  paddingY: '0.5rem',
  borderRadius: '0.75rem',
  backgroundColor: 'greyscale.100',
  color: 'greyscale.900',
  fontSize: '0.875rem',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
})
const userMetaCss = css({
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  '& > p': { minWidth: 0 },
})
const metaCss = css({
  margin: 0,
  color: 'default.subtle-text',
  fontSize: '0.75rem',
})
const bodyCss = css({
  margin: 0,
  color: 'default.text',
  fontSize: '0.875rem',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
})
const hintCss = css({ margin: 0, color: 'default.subtle-text' })
const errorCss = css({ margin: 0, color: 'danger.subtle-text' })
const timelineCss = css({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
})
const timelineItemCss = css({
  position: 'relative',
  paddingLeft: '1rem',
  borderLeft: '1px solid token(colors.greyscale.300)',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  _before: {
    content: '""',
    position: 'absolute',
    left: '-0.25rem',
    top: '0.25rem',
    width: '0.4375rem',
    height: '0.4375rem',
    borderRadius: '999px',
    backgroundColor: 'primary.500',
  },
})
