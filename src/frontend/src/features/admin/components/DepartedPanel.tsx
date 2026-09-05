import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import Table, { type ColumnProps } from '@douyinfe/semi-ui/lib/es/table'

import { css } from '@/styled-system/css'
import { Button, Input } from '@/primitives'
import { useConfirm } from '@/components/ConfirmProvider'
import { StateHint } from '@/components/StateHint'

import {
  type AdminMember,
  fetchAdminMembers,
  purgeMember,
  rehireMember,
} from '../api/adminMembers'
import { describeApiError } from '../api/errors'

const PAGE_SIZE = 20

/**
 * 已离职成员 — the third tab, mirroring 飞书's 已离职成员 list.
 *
 * Every column here reads from `left_snapshot` rather than the live rows: the
 * member's department may have been renamed or soft-deleted since they left, so
 * "department before leaving" cannot be a join. `left_days` is computed
 * server-side for the same reason it isn't stored — it changes every night.
 */
export const DepartedPanel = () => {
  const { t } = useTranslation('admin')
  const queryClient = useQueryClient()
  const { confirm, alert: showAlert } = useConfirm()

  const [page, setPage] = useState(1)
  const [after, setAfter] = useState('')
  const [before, setBefore] = useState('')

  const {
    data,
    isFetching,
    isError,
    refetch: refetchDeparted,
  } = useQuery({
    queryKey: ['admin', 'members', 'left', { page, after, before }],
    queryFn: () =>
      fetchAdminMembers({
        status: 'left',
        page,
        ordering: '-left_at',
        left_after: after ? `${after}T00:00:00Z` : undefined,
        left_before: before ? `${before}T23:59:59Z` : undefined,
      }),
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['admin', 'members'] })
  const onError = (e: unknown) => showAlert({ message: describeApiError(e) })

  const rehireMut = useMutation({
    mutationFn: (id: string) => rehireMember(id),
    onSuccess: invalidate,
    onError,
  })
  const purgeMut = useMutation({
    mutationFn: (id: string) => purgeMember(id),
    onSuccess: invalidate,
    onError,
  })

  const displayName = (m: AdminMember) =>
    m.full_name || m.short_name || m.email || m.sub || ''

  const rows = data?.results ?? []

  const columns: ColumnProps<AdminMember>[] = [
    {
      title: t('members.colMember'),
      width: 240,
      render: (_: unknown, m: AdminMember) => (
        <span className={css({ minWidth: 0 })}>
          <span className={nameCls}>{displayName(m)}</span>
          <span className={emailCls}>{m.email}</span>
        </span>
      ),
    },
    {
      title: t('members.colDepartmentBeforeLeaving'),
      width: 180,
      render: (_: unknown, m: AdminMember) =>
        m.left_snapshot?.department_name || t('members.orgLevel'),
    },
    {
      title: t('members.colLeftDays'),
      width: 100,
      render: (_: unknown, m: AdminMember) =>
        m.left_days === null
          ? '—'
          : t('members.daysAgo', { count: m.left_days }),
    },
    {
      title: t('members.colLeftAt'),
      width: 140,
      render: (_: unknown, m: AdminMember) =>
        m.left_at ? new Date(m.left_at).toLocaleDateString() : '—',
    },
    {
      title: t('members.colLeaveReason'),
      width: 140,
      render: (_: unknown, m: AdminMember) => m.left_reason || '—',
    },
    {
      title: '',
      width: 170,
      render: (_: unknown, m: AdminMember) => (
        <span className={css({ display: 'flex', gap: '0.375rem' })}>
          <Button
            variant="secondary"
            size="dense"
            loading={rehireMut.isPending && rehireMut.variables === m.id}
            isDisabled={purgeMut.isPending}
            onPress={async () => {
              const ok = await confirm({
                message: t('members.rehireConfirm', { name: displayName(m) }),
              })
              if (ok) rehireMut.mutate(m.id)
            }}
          >
            {t('members.rehire')}
          </Button>
          <Button
            variant="secondaryText"
            size="dense"
            loading={purgeMut.isPending && purgeMut.variables === m.id}
            isDisabled={rehireMut.isPending}
            onPress={async () => {
              const ok = await confirm({
                message: t('members.purgeConfirm', { name: displayName(m) }),
                danger: true,
              })
              if (ok) purgeMut.mutate(m.id)
            }}
          >
            {t('members.purge')}
          </Button>
        </span>
      ),
    },
  ]

  return (
    <div>
      <div className={filtersCls}>
        <label className={filterLabelCls}>
          {t('members.leftAfter')}
          <Input
            type="date"
            value={after}
            onChange={(e) => {
              setAfter(e.target.value)
              setPage(1)
            }}
            className={dateCls}
          />
        </label>
        <label className={filterLabelCls}>
          {t('members.leftBefore')}
          <Input
            type="date"
            value={before}
            onChange={(e) => {
              setBefore(e.target.value)
              setPage(1)
            }}
            className={dateCls}
          />
        </label>
      </div>

      {isError && rows.length === 0 ? (
        <StateHint
          state="error"
          action={
            <Button
              variant="secondary"
              size="dense"
              onPress={() => void refetchDeparted()}
            >
              {t('feedback.retry')}
            </Button>
          }
        >
          {t('feedback.loadFailed')}
        </StateHint>
      ) : (
        <Table<AdminMember>
          columns={columns}
          dataSource={rows}
          rowKey="id"
          loading={isFetching && rows.length === 0}
          size="middle"
          empty={t('members.noDeparted')}
          pagination={{
            currentPage: page,
            pageSize: PAGE_SIZE,
            total: data?.count ?? 0,
            onPageChange: setPage,
            showTotal: false,
            formatPageText: () =>
              t('members.total', { count: data?.count ?? 0 }),
          }}
        />
      )}
    </div>
  )
}

const nameCls = css({
  display: 'block',
  fontWeight: 'medium',
  color: 'greyscale.900',
})
const emailCls = css({
  display: 'block',
  fontSize: '0.75rem',
  color: 'greyscale.500',
})
const filtersCls = css({
  display: 'flex',
  gap: '1rem',
  alignItems: 'center',
  padding: '0.75rem 1.25rem',
  flexWrap: 'wrap',
})
const filterLabelCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  fontSize: '0.8125rem',
  color: 'greyscale.600',
})
const dateCls = css({
  width: '10rem',
})
