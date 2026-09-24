import { useState } from 'react'
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { Link, Route, Switch } from 'wouter'
import { MeetingDetailHeader } from '../components/MeetingDetailHeader'
import {
  readMeetingListState,
  useMeetingListNavigation,
} from './useMeetingListNavigation'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
const path = '/meeting/notes'
function List() {
  const [query, setQuery] = useState(
    () => readMeetingListState<string>('owner', path)?.value ?? ''
  )
  const navigation = useMeetingListNavigation('owner', path, query)
  return (
    <main onClickCapture={navigation.onClickCapture}>
      <input
        aria-label="Filter"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div ref={navigation.region} data-testid="list">
        <Link href="/meeting/records/one">Open record</Link>
      </div>
    </main>
  )
}
function Detail({ viewerId = 'owner' }: { viewerId?: string }) {
  return (
    <MeetingDetailHeader
      viewerId={viewerId}
      listHref={path}
      listLabel="Records"
      title="Lesson"
    />
  )
}
function App() {
  return (
    <Switch>
      <Route path={path}>
        <List />
      </Route>
      <Route path="/meeting/records/:id">
        <Detail />
      </Route>
    </Switch>
  )
}
beforeEach(() =>
  window.history.replaceState(null, '', `${path}?source_type=upload`)
)

it('restores the list URL, local filter, and scroll position through the heading link', () => {
  render(<App />)
  fireEvent.change(screen.getByLabelText('Filter'), {
    target: { value: 'lesson' },
  })
  screen.getByTestId('list').scrollTop = 420
  fireEvent.click(screen.getByRole('link', { name: 'Open record' }))
  expect(
    screen.getByRole('heading', { level: 1, name: 'Lesson' })
  ).toHaveAttribute('aria-current', 'page')
  expect(screen.getByRole('link', { name: 'Records' })).toHaveAttribute(
    'href',
    `${path}?source_type=upload`
  )
  fireEvent.click(screen.getByRole('link', { name: 'Records' }))
  expect(screen.getByLabelText('Filter')).toHaveValue('lesson')
  expect(screen.getByTestId('list').scrollTop).toBe(420)
})

it('also preserves the original list entry for browser Back', async () => {
  render(<App />)
  fireEvent.change(screen.getByLabelText('Filter'), {
    target: { value: 'browser back' },
  })
  fireEvent.click(screen.getByRole('link', { name: 'Open record' }))
  act(() => window.history.back())
  await waitFor(() =>
    expect(screen.getByLabelText('Filter')).toHaveValue('browser back')
  )
})

it('uses the default parent for a direct detail link', () => {
  window.history.replaceState(null, '', '/meeting/records/one')
  render(<Detail />)
  expect(screen.getByRole('link', { name: 'Records' })).toHaveAttribute(
    'href',
    path
  )
})

it('does not restore another viewer or another list snapshot', () => {
  window.history.replaceState(
    {
      meetingList: {
        viewerId: 'other',
        path,
        href: `${path}?source_type=upload`,
        value: 'private search',
        scrollTop: 100,
      },
    },
    '',
    '/meeting/records/one'
  )
  const view = render(<Detail />)
  expect(screen.getByRole('link', { name: 'Records' })).toHaveAttribute(
    'href',
    path
  )
  view.unmount()
  window.history.replaceState(
    {
      meetingList: {
        viewerId: 'owner',
        path: '/meeting/minutes',
        href: '/meeting/minutes',
        value: 'minutes filter',
        scrollTop: 100,
      },
    },
    '',
    '/meeting/records/one'
  )
  render(<Detail />)
  expect(screen.getByRole('link', { name: 'Records' })).toHaveAttribute(
    'href',
    path
  )
})
