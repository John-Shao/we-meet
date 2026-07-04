import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RiAddLine } from '@remixicon/react'

import { css } from '@/styled-system/css'
import { Button } from '@/primitives'
import { useConfirm } from '@/components/ConfirmProvider'
import { ResizablePanel } from '@/components/ResizablePanel'
import { fetchDepartmentMembers } from '@/features/contacts/api/fetchDepartmentMembers'
import { fetchDirectoryMembers } from '@/features/contacts/api/fetchDirectoryMembers'

import {
  type AdminDepartment,
  createDepartment,
  deleteDepartment,
  fetchAdminDepartments,
  moveDepartment,
  updateDepartment,
} from '../api/adminDepartments'
import { describeApiError } from '../api/errors'
import { DepartmentAdminTree } from '../components/DepartmentAdminTree'
import { TextPromptDialog } from '../components/TextPromptDialog'
import { DeleteDepartmentDialog } from '../components/DeleteDepartmentDialog'
import { SelectDialog } from '../components/SelectDialog'

type PromptState =
  | { mode: 'create'; parent: AdminDepartment | null }
  | { mode: 'rename'; dept: AdminDepartment }
  | null

const DEPARTMENTS_KEY = ['admin', 'departments']

export const AdminOrg = () => {
  const { t } = useTranslation('admin')
  const { alert: showAlert } = useConfirm()
  const queryClient = useQueryClient()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<PromptState>(null)
  const [deleteTarget, setDeleteTarget] = useState<AdminDepartment | null>(null)
  const [moveTarget, setMoveTarget] = useState<AdminDepartment | null>(null)
  const [headTarget, setHeadTarget] = useState<AdminDepartment | null>(null)

  const { data: departments = [] } = useQuery({
    queryKey: DEPARTMENTS_KEY,
    queryFn: fetchAdminDepartments,
    staleTime: 30_000,
  })

  const { data: members = [], isFetching: membersFetching } = useQuery({
    queryKey: ['admin', 'deptMembers', selectedId],
    queryFn: () => fetchDepartmentMembers(selectedId as string),
    enabled: selectedId !== null,
    staleTime: 30_000,
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: DEPARTMENTS_KEY })

  const onError = (e: unknown) => showAlert({ message: describeApiError(e) })

  const createMut = useMutation({
    mutationFn: (vars: { name: string; parent: string | null }) =>
      createDepartment({ name: vars.name, parent: vars.parent }),
    onSuccess: () => {
      invalidate()
      setPrompt(null)
    },
    onError,
  })

  const renameMut = useMutation({
    mutationFn: (vars: { id: string; name: string }) =>
      updateDepartment(vars.id, { name: vars.name }),
    onSuccess: () => {
      invalidate()
      setPrompt(null)
    },
    onError,
  })

  const deleteMut = useMutation({
    mutationFn: (vars: { id: string; reassignTo: string | null }) =>
      deleteDepartment(vars.id, vars.reassignTo),
    onSuccess: (_data, vars) => {
      invalidate()
      if (selectedId === vars.id) setSelectedId(null)
      setDeleteTarget(null)
    },
    onError,
  })

  const moveMut = useMutation({
    mutationFn: (vars: { id: string; parent: string | null }) =>
      moveDepartment(vars.id, vars.parent),
    onSuccess: () => {
      invalidate()
      setMoveTarget(null)
    },
    onError,
  })

  const headMut = useMutation({
    mutationFn: (vars: { id: string; head: string | null }) =>
      updateDepartment(vars.id, { head: vars.head }),
    onSuccess: () => {
      invalidate()
      setHeadTarget(null)
    },
    onError,
  })

  // Org members for the head picker (head must be an active member; backend
  // enforces via validate_head). Loaded only while the picker is open.
  const { data: orgMembers = [] } = useQuery({
    queryKey: ['admin', 'orgMembers'],
    queryFn: () => fetchDirectoryMembers(),
    enabled: headTarget !== null,
    staleTime: 60_000,
  })

  // Valid move targets: any department that is NOT the node itself and NOT in
  // its subtree (a materialized-path prefix match), plus "top level".
  const moveOptions = moveTarget
    ? [
        { value: '', label: t('org.moveToTop') },
        ...departments
          .filter(
            (d) =>
              d.id !== moveTarget.id && !d.path.startsWith(moveTarget.path),
          )
          .map((d) => ({ value: d.id, label: d.name })),
      ]
    : []

  const submitPrompt = (value: string) => {
    if (prompt?.mode === 'create') {
      createMut.mutate({ name: value, parent: prompt.parent?.id ?? null })
    } else if (prompt?.mode === 'rename') {
      renameMut.mutate({ id: prompt.dept.id, name: value })
    }
  }

  const selectedDept = departments.find((d) => d.id === selectedId) ?? null

  return (
    <div className={css({ display: 'flex', flexDirection: 'column', height: '100%' })}>
      <div
        className={css({
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingX: '1.25rem',
          paddingY: '0.875rem',
          borderBottom: '1px solid token(colors.greyscale.200)',
        })}
      >
        <h1 className={css({ fontSize: '1.125rem', fontWeight: 'bold', color: 'greyscale.900' })}>
          {t('org.title')}
        </h1>
        <Button
          size="sm"
          variant="primary"
          icon={<RiAddLine size={16} />}
          onPress={() => setPrompt({ mode: 'create', parent: null })}
        >
          {t('org.newDepartment')}
        </Button>
      </div>

      <div className={css({ flex: 1, display: 'flex', minHeight: 0, overflow: 'hidden' })}>
        <ResizablePanel
          storageKey="we-meet:admin-org-tree-width"
          defaultWidth={300}
          min={240}
          max={480}
        >
          <aside
            className={css({
              width: '100%',
              height: '100%',
              borderRight: '1px solid token(colors.greyscale.200)',
              overflowY: 'auto',
              backgroundColor: 'greyscale.50',
            })}
          >
            {departments.length === 0 ? (
              <p className={css({ padding: '1rem', color: 'greyscale.500', fontSize: '0.875rem' })}>
                {t('org.empty')}
              </p>
            ) : (
              <DepartmentAdminTree
                departments={departments}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onAddChild={(parent) => setPrompt({ mode: 'create', parent })}
                onRename={(dept) => setPrompt({ mode: 'rename', dept })}
                onMove={setMoveTarget}
                onDelete={setDeleteTarget}
              />
            )}
          </aside>
        </ResizablePanel>

        <main className={css({ flex: 1, minWidth: 0, overflowY: 'auto' })}>
          {selectedDept === null ? (
            <p className={css({ padding: '1.5rem', color: 'greyscale.500', fontSize: '0.9375rem' })}>
              {t('org.selectDept')}
            </p>
          ) : (
            <div className={css({ padding: '1.25rem' })}>
              <h2 className={css({ fontSize: '1rem', fontWeight: 'bold', marginBottom: '0.5rem', color: 'greyscale.900' })}>
                {selectedDept.name}
              </h2>
              <div
                className={css({
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  marginBottom: '1rem',
                  fontSize: '0.875rem',
                  color: 'greyscale.600',
                })}
              >
                <span>{t('org.head')}:</span>
                <span className={css({ color: 'greyscale.900' })}>
                  {selectedDept.head
                    ? selectedDept.head.full_name || selectedDept.head.short_name
                    : t('org.noHead')}
                </span>
                <button
                  type="button"
                  onClick={() => setHeadTarget(selectedDept)}
                  className={css({
                    border: '1px solid token(colors.primary.300)',
                    borderRadius: '0.375rem',
                    backgroundColor: 'greyscale.000',
                    color: 'primary.600',
                    paddingX: '0.5rem',
                    paddingY: '0.1875rem',
                    fontSize: '0.8125rem',
                    cursor: 'pointer',
                    _hover: { backgroundColor: 'primary.50' },
                  })}
                >
                  {t('org.setHead')}
                </button>
              </div>
              {membersFetching && members.length === 0 ? (
                <p className={css({ color: 'greyscale.500', fontSize: '0.875rem' })}>{t('org.loadingMembers')}</p>
              ) : members.length === 0 ? (
                <p className={css({ color: 'greyscale.500', fontSize: '0.875rem' })}>{t('org.noMembers')}</p>
              ) : (
                <ul className={css({ listStyle: 'none', margin: 0, padding: 0 })}>
                  {members.map((m) => (
                    <li
                      key={m.id}
                      className={css({
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        paddingY: '0.5rem',
                        borderBottom: '1px solid token(colors.greyscale.100)',
                        fontSize: '0.875rem',
                      })}
                    >
                      <span className={css({ color: 'greyscale.900' })}>
                        {m.full_name || m.short_name || m.email}
                      </span>
                      <span className={css({ color: 'greyscale.500', fontSize: '0.8125rem' })}>
                        {m.title}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </main>
      </div>

      <TextPromptDialog
        isOpen={prompt !== null}
        title={prompt?.mode === 'rename' ? t('org.renameTitle') : t('org.createTitle')}
        label={t('org.namePlaceholder')}
        initialValue={prompt?.mode === 'rename' ? prompt.dept.name : ''}
        confirmLabel={prompt?.mode === 'rename' ? t('actions.save') : t('actions.create')}
        submitting={createMut.isPending || renameMut.isPending}
        onSubmit={submitPrompt}
        onClose={() => setPrompt(null)}
      />

      <DeleteDepartmentDialog
        isOpen={deleteTarget !== null}
        department={deleteTarget}
        candidates={departments.filter((d) => d.id !== deleteTarget?.id)}
        submitting={deleteMut.isPending}
        onConfirm={(reassignTo) =>
          deleteTarget && deleteMut.mutate({ id: deleteTarget.id, reassignTo })
        }
        onClose={() => setDeleteTarget(null)}
      />

      <SelectDialog
        isOpen={moveTarget !== null}
        title={t('org.moveTitle', { name: moveTarget?.name ?? '' })}
        label={t('org.moveLabel')}
        options={moveOptions}
        initialValue={moveTarget?.parent ?? ''}
        confirmLabel={t('org.move')}
        submitting={moveMut.isPending}
        onSubmit={(value) =>
          moveTarget && moveMut.mutate({ id: moveTarget.id, parent: value || null })
        }
        onClose={() => setMoveTarget(null)}
      />

      <SelectDialog
        isOpen={headTarget !== null}
        title={t('org.setHeadTitle', { name: headTarget?.name ?? '' })}
        label={t('org.head')}
        options={[
          { value: '', label: t('org.noHead') },
          ...orgMembers.map((m) => ({
            value: m.id,
            label: m.full_name || m.short_name || m.email || '',
          })),
        ]}
        initialValue={headTarget?.head?.id ?? ''}
        confirmLabel={t('actions.save')}
        submitting={headMut.isPending}
        onSubmit={(value) =>
          headTarget && headMut.mutate({ id: headTarget.id, head: value || null })
        }
        onClose={() => setHeadTarget(null)}
      />
    </div>
  )
}
