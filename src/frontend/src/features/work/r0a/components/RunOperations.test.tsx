import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkOperation } from '../api/types'
import { RunOperations } from './RunOperations'

const state = vi.hoisted(() => ({
  pages: [] as { items: unknown[]; next_cursor: string | null }[],
  isLoading: false,
  isError: false,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      // A defaultValue-only call is "ask for the label, fall back to the raw
      // value", so the mock answers with the key and the assertion below shows
      // that the component asked at all.
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

vi.mock('../api/queries', () => ({
  useWorkRunOperations: () => ({
    data: state.pages.length > 0 ? { pages: state.pages } : undefined,
    isLoading: state.isLoading,
    isError: state.isError,
  }),
}))

const operation = (over: Partial<WorkOperation>): WorkOperation => ({
  id: 'op-1',
  run_id: 'run-1',
  logical_key: 'model:1',
  kind: 'model',
  state: 'succeeded',
  request_hash: 'sha256:m',
  provider_request_id: null,
  receipt_ref: null,
  revision: 0,
  created_at: '2026-11-02T10:00:00Z',
  updated_at: '2026-11-02T10:00:05Z',
  ...over,
})

const withRun = () => render(<RunOperations runId="run-1" />)

beforeEach(() => {
  state.isLoading = false
  state.isError = false
  state.pages = [
    {
      items: [
        operation({
          id: 'op-model',
          logical_key: 'model:1',
          provider_request_id: 'req-1',
        }),
        operation({
          id: 'op-tool-1',
          logical_key: 'tool:1',
          kind: 'tool',
          state: 'dispatching',
        }),
        operation({
          id: 'op-tool-2',
          logical_key: 'tool:2',
          kind: 'tool',
          state: 'unresolved',
        }),
      ],
      next_cursor: null,
    },
  ]
})

afterEach(cleanup)

describe('RunOperations', () => {
  it('shows decision steps and folds the tool calls behind a count', () => {
    withRun()
    expect(
      screen.getByRole('heading', { name: 'task.operations' })
    ).toBeTruthy()
    expect(screen.getByText('model:1')).toBeTruthy()
    expect(screen.getByText('operationState.succeeded')).toBeTruthy()
    // A provider request id is a locator, not content, so it is the only extra
    // line a row may carry.
    expect(
      screen.getByText('task.operations.provider:{"id":"req-1"}')
    ).toBeTruthy()

    const summary = screen.getByText('task.operations.toolSteps:{"count":2}')
    const disclosure = summary.closest('details')
    expect(disclosure).toBeTruthy()
    // "折叠" is the default state rather than an option: tool calls are the bulk
    // of the list and the owner asks about them last.
    expect(disclosure?.hasAttribute('open')).toBe(false)
    expect(screen.getByText('tool:1')).toBeTruthy()
    expect(screen.getByText('operationState.dispatching')).toBeTruthy()
  })

  it('keeps an unresolved step visible outside the tool group', () => {
    state.pages = [
      {
        items: [
          operation({
            id: 'op-a',
            logical_key: 'artifact:1',
            kind: 'artifact',
          }),
          operation({
            id: 'op-m',
            logical_key: 'model:2',
            state: 'unresolved',
          }),
        ],
        next_cursor: null,
      },
    ]
    withRun()
    expect(screen.getByText('artifact:1')).toBeTruthy()
    expect(screen.getByText('model:2')).toBeTruthy()
    expect(screen.getByText('operationState.unresolved')).toBeTruthy()
    // Nothing to fold, so the disclosure is not rendered at all instead of an
    // empty "Tool steps (0)".
    expect(screen.queryByText(/task\.operations\.toolSteps/)).toBeNull()
  })

  // The enum must never reach the screen: this is the same leak that was fixed
  // for permission_mode in the workspace header.
  it('localizes every operation state instead of rendering the enum', () => {
    withRun()
    for (const raw of ['succeeded', 'dispatching', 'unresolved']) {
      expect(screen.queryByText(raw)).toBeNull()
    }
  })

  it('distinguishes an empty run from an unreadable one', () => {
    state.pages = [{ items: [], next_cursor: null }]
    withRun()
    expect(screen.getByText('task.operationsEmpty')).toBeTruthy()
    expect(screen.queryByRole('listitem')).toBeNull()
    cleanup()

    state.pages = []
    state.isError = true
    withRun()
    expect(screen.getByText('task.operationsUnavailable')).toBeTruthy()
    expect(screen.queryByText('task.operationsEmpty')).toBeNull()
    cleanup()

    state.isError = false
    state.isLoading = true
    withRun()
    expect(screen.getByText('loading')).toBeTruthy()
  })

  it('renders nothing without a run', () => {
    render(<RunOperations runId={undefined} />)
    expect(screen.queryByText('task.operations')).toBeNull()
  })
})
