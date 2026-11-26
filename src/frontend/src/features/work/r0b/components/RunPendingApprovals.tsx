import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'

import { Button } from '@/primitives/Button'
import { css } from '@/styled-system/css'

import { errorText, muted, sectionTitle } from '../../r0a/ui'
import { useWorkPendingLocalApprovals } from '../api/queries'
import type { PendingLocalApproval } from '../../../../../../desktop/src/work/bridge'

const list = css({
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 'xs',
})

const item = css({
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  gap: 'sm',
  paddingY: 'xs',
  borderTop: '1px solid token(colors.border.subtle)',
  textStyle: 'bodyMedium',
})

export const RunPendingApprovals = ({ taskId }: { taskId: string }) => {
  const { t, i18n } = useTranslation('work')
  const queryClient = useQueryClient()
  const approvalsQ = useWorkPendingLocalApprovals(taskId, true)
  const [opening, setOpening] = useState<string | null>(null)
  const [failure, setFailure] = useState(false)

  useEffect(() => {
    const bridge = window.weMeetDesktop?.work
    if (!bridge?.onApprovalDecided) return
    return bridge.onApprovalDecided(() => {
      void queryClient.invalidateQueries({ queryKey: ['work', 'r0b'] })
      void queryClient.invalidateQueries({ queryKey: ['work', 'task', taskId] })
    })
  }, [queryClient, taskId])

  const approvals = (approvalsQ.data ?? []).filter(
    (approval) => approval.taskId === taskId
  )
  if (approvals.length === 0) return null

  const open = async (approval: PendingLocalApproval) => {
    const bridge = window.weMeetDesktop?.work
    if (!bridge) return
    setOpening(approval.approvalId)
    setFailure(false)
    try {
      const result = await bridge.openLocalContent(
        'approval',
        approval.approvalId
      )
      if (result.status !== 'opened') setFailure(true)
    } catch {
      setFailure(true)
    } finally {
      setOpening(null)
    }
  }

  return (
    <section
      className={css({ display: 'flex', flexDirection: 'column', gap: 'xs' })}
      aria-labelledby="work-run-pending-approvals"
    >
      <h2 id="work-run-pending-approvals" className={sectionTitle}>
        {t('task.pendingApprovals')}
      </h2>
      {failure ? (
        <p className={errorText} role="alert">
          {t('task.pendingApprovalOpenFailed')}
        </p>
      ) : null}
      <ul className={list}>
        {approvals.map((approval) => (
          <li key={approval.approvalId} className={item}>
            <span>{approval.actionKind}</span>
            <span className={muted}>{approval.risk}</span>
            <span className={muted}>
              {t('task.pendingApprovalExpires', {
                time: new Date(approval.expiresAt).toLocaleString(
                  i18n.language,
                  {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }
                ),
              })}
            </span>
            <Button
              variant="secondary"
              size="dense"
              loading={opening === approval.approvalId}
              onPress={() => void open(approval)}
            >
              {t('task.pendingApprovalReview')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}
