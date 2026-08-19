import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RiAddLine, RiDeleteBinLine } from '@remixicon/react'

import { css } from '@/styled-system/css'
import { Button } from '@/primitives'
import { useConfirm } from '@/components/ConfirmProvider'
import { ResizablePanel } from '@/components/ResizablePanel'

import {
  type UserGroup,
  createUserGroup,
  deleteUserGroup,
  fetchUserGroupMembers,
  fetchUserGroups,
  removeUserGroupMember,
  updateUserGroup,
} from '../api/adminUserGroups'
import { describeApiError } from '../api/errors'
import { TextPromptDialog } from '../components/TextPromptDialog'
import { GroupMembersDialog } from '../components/GroupMembersDialog'

const GROUPS_KEY = ['admin', 'user-groups']

/**
 * 「用户组」—— 一个用户组是**可被授权的主体**,不是「存下来的一批人」。
 *
 * 所以这一页刻意把 `group_key` 摆在明面上:授权行里存的就是它,它不可变,而
 * 「把某个录制共享给这个组」最终就是拿这串字符去建一行授权。管理员看不到它的
 * 话,组与权限之间那层关系就只剩口口相传。
 */
export const AdminUserGroups = () => {
  const { t } = useTranslation('admin')
  const { confirm, alert: showAlert } = useConfirm()
  const queryClient = useQueryClient()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [renameTarget, setRenameTarget] = useState<UserGroup | null>(null)
  const [addingTo, setAddingTo] = useState<UserGroup | null>(null)

  const { data: groups = [] } = useQuery({
    queryKey: GROUPS_KEY,
    queryFn: () => fetchUserGroups(),
    staleTime: 30_000,
  })

  const { data: members = [], isFetching: membersFetching } = useQuery({
    queryKey: ['admin', 'user-group-members', selectedId],
    queryFn: () => fetchUserGroupMembers(selectedId as string),
    enabled: selectedId !== null,
    staleTime: 30_000,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: GROUPS_KEY })
    queryClient.invalidateQueries({ queryKey: ['admin', 'user-group-members'] })
  }
  const onError = (e: unknown) => showAlert({ message: describeApiError(e) })

  const createMut = useMutation({
    mutationFn: (name: string) => createUserGroup({ name }),
    onSuccess: (group) => {
      invalidate()
      setCreating(false)
      setSelectedId(group.id)
    },
    onError,
  })

  const renameMut = useMutation({
    mutationFn: (vars: { id: string; name: string }) =>
      updateUserGroup(vars.id, { name: vars.name }),
    onSuccess: () => {
      invalidate()
      setRenameTarget(null)
    },
    onError,
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteUserGroup(id),
    onSuccess: (_data, id) => {
      invalidate()
      if (selectedId === id) setSelectedId(null)
    },
    onError,
  })

  const removeMemberMut = useMutation({
    mutationFn: (vars: { id: string; userId: string }) =>
      removeUserGroupMember(vars.id, vars.userId),
    onSuccess: invalidate,
    onError,
  })

  const selected = groups.find((g) => g.id === selectedId) ?? null

  const remove = async (group: UserGroup) => {
    const ok = await confirm({
      // 说清后果:删组不会撤销已建的授权行,只是让它们解析不到人。
      message: t('groups.deleteConfirm', { name: group.name }),
      danger: true,
    })
    if (ok) deleteMut.mutate(group.id)
  }

  return (
    <div className={pageCls}>
      <div className={headerCls}>
        <h1 className={titleCls}>{t('groups.title')}</h1>
        <Button
          size="sm"
          variant="primary"
          icon={<RiAddLine size={16} />}
          onPress={() => setCreating(true)}
        >
          {t('groups.newGroup')}
        </Button>
      </div>

      <div className={bodyCls}>
        <ResizablePanel
          storageKey="we-meet:admin-groups-width"
          defaultWidth={280}
          min={220}
          max={420}
        >
          <aside className={listCls}>
            {groups.length === 0 ? (
              <p className={hintCls}>{t('groups.empty')}</p>
            ) : (
              groups.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  onClick={() => setSelectedId(group.id)}
                  className={rowCls(group.id === selectedId)}
                >
                  <span className={rowNameCls}>{group.name}</span>
                  <span className={rowMetaCls}>
                    {t('groups.memberCount', { count: group.member_count })}
                  </span>
                </button>
              ))
            )}
          </aside>
        </ResizablePanel>

        <main className={detailCls}>
          {selected === null ? (
            <p className={hintCls}>{t('groups.selectGroup')}</p>
          ) : (
            <div className={css({ padding: '1.25rem' })}>
              <div className={detailHeadCls}>
                <h2 className={detailTitleCls}>{selected.name}</h2>
                <Button
                  variant="secondary"
                  size="dense"
                  onPress={() => setRenameTarget(selected)}
                >
                  {t('actions.rename')}
                </Button>
                <Button
                  variant="secondary"
                  size="dense"
                  onPress={() => setAddingTo(selected)}
                >
                  {t('groups.addMembers')}
                </Button>
                <Button
                  variant="tertiaryText"
                  size="dense"
                  onPress={() => void remove(selected)}
                >
                  {t('actions.delete')}
                </Button>
              </div>

              {/* 授权 key 明摆出来:授权行里存的就是它,而且它不可变。 */}
              <div className={keyRowCls}>
                <span className={keyLabelCls}>{t('groups.grantKey')}</span>
                <code className={keyCls}>{selected.group_key}</code>
              </div>
              <p className={keyHintCls}>{t('groups.grantKeyHint')}</p>

              <h3 className={sectionCls}>
                {t('groups.members')} ({selected.member_count})
              </h3>
              {membersFetching && members.length === 0 ? (
                <p className={hintCls}>{t('groups.loadingMembers')}</p>
              ) : members.length === 0 ? (
                <p className={hintCls}>{t('groups.noMembers')}</p>
              ) : (
                <ul
                  className={css({ listStyle: 'none', margin: 0, padding: 0 })}
                >
                  {members.map((m) => (
                    <li key={m.id} className={memberRowCls}>
                      <span className={css({ color: 'greyscale.900' })}>
                        {m.full_name || m.short_name || m.email}
                      </span>
                      <button
                        type="button"
                        title={t('groups.removeMember')}
                        aria-label={t('groups.removeMember')}
                        onClick={() =>
                          removeMemberMut.mutate({
                            id: selected.id,
                            userId: m.id,
                          })
                        }
                        className={removeBtnCls}
                      >
                        <RiDeleteBinLine size={15} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </main>
      </div>

      <TextPromptDialog
        isOpen={creating}
        title={t('groups.createTitle')}
        label={t('groups.namePlaceholder')}
        initialValue=""
        confirmLabel={t('actions.create')}
        submitting={createMut.isPending}
        onSubmit={(value) => createMut.mutate(value)}
        onClose={() => setCreating(false)}
      />

      <TextPromptDialog
        isOpen={renameTarget !== null}
        title={t('groups.renameTitle')}
        label={t('groups.namePlaceholder')}
        initialValue={renameTarget?.name ?? ''}
        confirmLabel={t('actions.save')}
        submitting={renameMut.isPending}
        onSubmit={(value) =>
          renameTarget && renameMut.mutate({ id: renameTarget.id, name: value })
        }
        onClose={() => setRenameTarget(null)}
      />

      <GroupMembersDialog
        group={addingTo}
        existingIds={new Set(members.map((m) => m.id))}
        onDone={() => {
          invalidate()
          setAddingTo(null)
        }}
        onClose={() => setAddingTo(null)}
      />
    </div>
  )
}

const pageCls = css({
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
})
const headerCls = css({
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingX: '1.25rem',
  paddingY: '0.875rem',
  borderBottom: '1px solid token(colors.greyscale.200)',
})
const titleCls = css({
  fontSize: '1.125rem',
  fontWeight: 'bold',
  color: 'greyscale.900',
})
const bodyCls = css({
  flex: 1,
  display: 'flex',
  minHeight: 0,
  overflow: 'hidden',
})
const listCls = css({
  width: '100%',
  height: '100%',
  borderRight: '1px solid token(colors.greyscale.200)',
  overflowY: 'auto',
  backgroundColor: 'greyscale.50',
})
const detailCls = css({ flex: 1, minWidth: 0, overflowY: 'auto' })
const hintCls = css({
  padding: '1.25rem',
  color: 'greyscale.500',
  fontSize: '0.875rem',
})
// 选中/未选中用两个完整类切换,不在一个 css() 里拿三元拼同一批属性 ——
// 悬停态尤其容易漏一个 _dark 分支(见 AdminShell 顶部那段说明)。
const rowBase = {
  width: '100%',
  display: 'block',
  textAlign: 'left',
  paddingX: '1rem',
  paddingY: '0.5rem',
  border: 'none',
  cursor: 'pointer',
} as const
const rowIdle = css({
  ...rowBase,
  backgroundColor: 'transparent',
  _hover: { backgroundColor: 'greyscale.100' },
})
const rowActive = css({
  ...rowBase,
  backgroundColor: 'selected.bg',
  _hover: { backgroundColor: 'selected.bg' },
})
const rowCls = (active: boolean) => (active ? rowActive : rowIdle)
const rowNameCls = css({
  display: 'block',
  fontSize: '0.875rem',
  color: 'greyscale.900',
})
const rowMetaCls = css({
  display: 'block',
  fontSize: '0.75rem',
  color: 'greyscale.500',
})
const detailHeadCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  marginBottom: '0.75rem',
})
const detailTitleCls = css({
  flex: 1,
  minWidth: 0,
  fontSize: '1rem',
  fontWeight: 'bold',
  color: 'greyscale.900',
})
const keyRowCls = css({
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
  fontSize: '0.8125rem',
})
const keyLabelCls = css({ color: 'greyscale.500' })
const keyCls = css({
  padding: '0.125rem 0.375rem',
  borderRadius: '4px',
  backgroundColor: 'greyscale.100',
  color: 'greyscale.800',
  fontFamily: 'monospace',
  fontSize: '0.75rem',
})
const keyHintCls = css({
  marginTop: '0.25rem',
  fontSize: '0.75rem',
  color: 'greyscale.500',
})
const sectionCls = css({
  marginTop: '1.25rem',
  marginBottom: '0.5rem',
  fontSize: '0.875rem',
  fontWeight: 'bold',
  color: 'greyscale.800',
})
const memberRowCls = css({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  paddingY: '0.5rem',
  borderBottom: '1px solid token(colors.greyscale.100)',
  fontSize: '0.875rem',
})
const removeBtnCls = css({
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: 'greyscale.500',
  _hover: { color: 'danger.subtle-text' },
})
