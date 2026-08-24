import { MemberAvatar } from '@/features/contacts'
import { css } from '@/styled-system/css'

import type { ApiTaskUser } from '../api/ApiTask'
import { taskDisplayName } from '../taskUi'

type Props = {
  user: ApiTaskUser | null
  size?: string
}

export const TaskUserAvatar = ({ user, size = '1.375rem' }: Props) => {
  if (!user) return null
  return (
    <MemberAvatar
      name={taskDisplayName(user)}
      src={user.avatar_url}
      size={size}
    />
  )
}

export const TaskUserDisplay = ({ user, size = '1.375rem' }: Props) => {
  if (!user) return <span>—</span>
  const name = taskDisplayName(user)
  return (
    <span className={userCss} title={name}>
      <TaskUserAvatar user={user} size={size} />
      <span className={nameCss}>{name}</span>
    </span>
  )
}

const userCss = css({
  minWidth: 0,
  maxWidth: '100%',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.375rem',
  verticalAlign: 'middle',
})

const nameCss = css({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
})
