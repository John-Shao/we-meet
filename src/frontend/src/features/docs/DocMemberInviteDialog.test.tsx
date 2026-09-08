import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { PropsWithChildren } from 'react'
import { DocMemberInviteDialog } from './DocMemberInviteDialog'

const mocks = vi.hoisted(() => ({ add: vi.fn(), members: vi.fn() }))
vi.mock('./api/docsSharing', () => ({
  addDocMembers: mocks.add,
  memberIds: mocks.members,
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/components/Modal', () => ({
  Modal: ({ children }: PropsWithChildren) => <div>{children}</div>,
  ModalBody: ({ children }: PropsWithChildren) => <div>{children}</div>,
  ModalFooter: ({ children }: PropsWithChildren) => <div>{children}</div>,
  ModalHeader: () => null,
}))
vi.mock('@/primitives', () => ({
  Button: ({
    children,
    onPress,
    isDisabled,
  }: PropsWithChildren<{ onPress: () => void; isDisabled?: boolean }>) => (
    <button disabled={isDisabled} onClick={onPress}>
      {children}
    </button>
  ),
}))
vi.mock('@/primitives/Select', () => ({
  Select: ({
    selectedKey,
    onSelectionChange,
  }: {
    selectedKey: string
    onSelectionChange: (value: string) => void
  }) => (
    <select
      aria-label="role"
      value={selectedKey}
      onChange={(event) => onSelectionChange(event.target.value)}
    >
      <option value="reader">Reader</option>
      <option value="editor">Editor</option>
    </select>
  ),
}))
vi.mock('@/features/contacts', () => ({
  DirectoryMultiPicker: ({
    onToggle,
    selected,
    excludeIds,
  }: {
    onToggle: (id: string, label: string) => void
    selected: Map<string, string>
    excludeIds: Set<string>
  }) => (
    <>
      {['existing', 'a', 'b']
        .filter((id) => !excludeIds.has(id))
        .map((id) => (
          <button
            key={id}
            onClick={() => onToggle(id, id)}
            aria-pressed={selected.has(id)}
          >
            {id}
          </button>
        ))}
    </>
  ),
}))
beforeEach(() => {
  vi.resetAllMocks()
  mocks.members.mockResolvedValue(['existing'])
})

it('uses directory IDs, excludes members, retains failed users, and retries only them', async () => {
  mocks.add.mockResolvedValueOnce(['b']).mockResolvedValueOnce([])
  const onChanged = vi.fn()
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <DocMemberInviteDialog
        docId="doc"
        title="Document"
        onClose={vi.fn()}
        onChanged={onChanged}
      />
    </QueryClientProvider>
  )
  await screen.findByRole('button', { name: 'a' })
  expect(
    screen.queryByRole('button', { name: 'existing' })
  ).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'a' }))
  fireEvent.click(screen.getByRole('button', { name: 'b' }))
  fireEvent.change(screen.getByRole('combobox'), {
    target: { value: 'editor' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'sharing.confirmCount' }))
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
  expect(mocks.add).toHaveBeenNthCalledWith(1, 'doc', ['a', 'b'], 'editor')
  expect(screen.getByRole('button', { name: 'b' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  expect(screen.getByRole('button', { name: 'a' })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
  fireEvent.click(screen.getByRole('button', { name: 'sharing.confirmCount' }))
  await waitFor(() =>
    expect(mocks.add).toHaveBeenNthCalledWith(2, 'doc', ['b'], 'editor')
  )
})
