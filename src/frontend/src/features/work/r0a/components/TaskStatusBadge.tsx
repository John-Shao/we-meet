import { useTranslation } from 'react-i18next'

import { Badge, type BadgeProps } from '@/primitives/Badge'

const TONE: Record<string, BadgeProps['tone']> = {
  open: 'neutral',
  queued: 'neutral',
  running: 'brand',
  awaiting_acceptance: 'warning',
  completed: 'success',
  failed: 'danger',
  run_canceled: 'neutral',
  reconciling: 'warning',
  quota_exhausted: 'danger',
  canceling: 'warning',
  canceled: 'neutral',
  archived: 'neutral',
}

export const TaskStatusBadge = ({ state }: { state: string }) => {
  const { t } = useTranslation('work')
  return (
    <Badge tone={TONE[state] ?? 'neutral'} size="sm">
      {t(`status.${state}`, { defaultValue: state })}
    </Badge>
  )
}
