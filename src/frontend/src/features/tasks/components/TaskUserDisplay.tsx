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

export const TaskAssigneesDisplay = ({
  users,
  size = '1.375rem',
}: {
  users: ApiTaskUser[]
  size?: string
}) => {
  if (users.length === 0) return <span>—</span>
  const names = users.map(taskDisplayName)
  return (
    <span className={assigneesCss} title={names.join('、')}>
      <span className={avatarStackCss}>
        {users.slice(0, 3).map((user) => (
          <span key={user.id} className={stackedAvatarCss}>
            <TaskUserAvatar user={user} size={size} />
          </span>
        ))}
      </span>
      <span className={nameCss}>{names[0]}</span>
      {users.length > 1 && <span className={moreCss}>+{users.length - 1}</span>}
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

const assigneesCss = css({
  minWidth: 0,
  maxWidth: '100%',
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.375rem',
})

const avatarStackCss = css({
  display: 'inline-flex',
  flexShrink: 0,
  '& > span:not(:first-child)': { marginLeft: '-0.45rem' },
})

const stackedAvatarCss = css({
  display: 'inline-flex',
  border: '1px solid token(colors.greyscale.000)',
  borderRadius: '999px',
})

const moreCss = css({
  flexShrink: 0,
  color: 'greyscale.600',
  fontSize: '0.75rem',
})
