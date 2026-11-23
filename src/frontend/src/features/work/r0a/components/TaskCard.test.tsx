import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkRun, WorkTaskSummary } from '../api/types'
import { TaskCard } from './TaskCard'

vi.mock('wouter', () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))

// The card's only job for device-design §3.3 is to forward the run it is showing and render on the
// server's answer. Three answers are possible - true, false, and "still in flight / failed"
// (undefined) - and the last must look like false: §3.3 forbids the stuck-task reading, not the
// plain running one, and an assumed "正在交回历史" is the harder mistake to take back.
const state = vi.hoisted(() => ({
  handback: undefined as boolean | undefined,
  calls: [] as [string | undefined, string | undefined][],
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      // A defaultValue-only call means "label it, else show the raw value", which is how the run
      // state is rendered; the mock answers with the key so the assertions can see the lookup.
      if (
        options &&
        Object.keys(options).length === 1 &&
        'defaultValue' in options
      ) {
        return key
      }
      return options ? `${key}:${JSON.stringify(options)}` : key
    },
    i18n: { language: 'zh' },
  }),
}))

vi.mock('../../r0b/api/queries', () => ({
  useWorkRunHistoryHandback: (
    runId: string | undefined,
    runState: string | undefined
  ) => {
    state.calls.push([runId, runState])
    return { data: state.handback }
  },
}))

// The card renders the run state through t('items.runState', { state: t('run.<state>', {defaultValue}) }),
// which the mocked translator turns into this exact string.
const RUN_STATE_TEXT = 'items.runState:{"state":"run.active"}'

const run = (over: Partial<WorkRun> = {}): WorkRun => ({
  id: 'run-1',
  task_id: 'task-1',
  attempt_no: 1,
  state: 'active',
  wait_reason: null,
  terminal_reason: null,
  control_revision: 0,
  runtime_version: 'rt-1',
  created_at: '2026-11-21T10:00:00Z',
  updated_at: '2026-11-21T10:00:05Z',
  ...over,
})

const task = (over: Partial<WorkTaskSummary> = {}): WorkTaskSummary => ({
  task_id: 'task-1',
  title: 'Write the summary',
  display_state: 'running',
  task_state: 'open',
  permission_mode: 'ask_each',
  active_run_id: 'run-1',
  latest_run_id: 'run-1',
  latest_run: run(),
  latest_artifact: null,
  revision: 1,
  pending_acceptance: false,
  blocking_operations: 0,
  quota: { reserved_tokens: 0, settled_tokens: 0 },
  created_at: '2026-11-21T10:00:00Z',
  updated_at: '2026-11-21T10:00:05Z',
  ...over,
})

beforeEach(() => {
  state.handback = undefined
  state.calls = []
})

afterEach(cleanup)

describe('TaskCard history hand-back line', () => {
  it('shows §3.3 the sentence when the server reports a live hand-back lease', () => {
    state.handback = true
    render(<TaskCard task={task()} />)
    expect(screen.getByTestId('run-history-handback').textContent).toBe(
      'items.handback'
    )
    expect(state.calls).toEqual([['run-1', 'active']])
    // The projection sits beside the run state rather than replacing it (control-design §4.2): the
    // run is still `active`, and that sentence is still on the card.
    expect(screen.getByText(RUN_STATE_TEXT)).toBeTruthy()
  })

  it('stays quiet when the ledger says the run is not handing back', () => {
    state.handback = false
    render(<TaskCard task={task()} />)
    expect(screen.queryByTestId('run-history-handback')).toBeNull()
    expect(screen.getByText(RUN_STATE_TEXT)).toBeTruthy()
  })

  it('treats an in-flight or failed read as not-handing-back, never as stuck', () => {
    state.handback = undefined
    render(<TaskCard task={task()} />)
    expect(screen.queryByTestId('run-history-handback')).toBeNull()
    // Nothing on the card may read as a failure either: the line's absence is the same copy the
    // pre-batch card had.
    expect(screen.queryByText(/errors\./)).toBeNull()
    expect(state.calls).toEqual([['run-1', 'active']])
  })

  it('asks about the run it shows, and only about that run', () => {
    // The id and state forwarded are what decides whether the read happens at all (0059's mint
    // requires an active run), so a card that handed over the wrong pair would mute the feature.
    render(
      <TaskCard
        task={task({ latest_run: run({ id: 'run-7', state: 'waiting' }) })}
      />
    )
    expect(state.calls).toEqual([['run-7', 'waiting']])
    expect(screen.queryByTestId('run-history-handback')).toBeNull()
  })

  it('forwards no run identity when the task has no run', () => {
    // useWorkRunHistoryHandback is enabled on `!!runId && runState === 'active'`, so this pair is
    // what keeps the read off a task with nothing executing. The card itself only ever renders on
    // the server's yes, so with no id there is no yes to render.
    render(
      <TaskCard
        task={task({
          latest_run: null,
          active_run_id: null,
          latest_run_id: null,
        })}
      />
    )
    expect(state.calls).toEqual([[undefined, undefined]])
    expect(screen.queryByTestId('run-history-handback')).toBeNull()
    expect(screen.queryByText(RUN_STATE_TEXT)).toBeNull()
  })
})
