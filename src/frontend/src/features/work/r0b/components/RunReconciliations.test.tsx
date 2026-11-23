import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RunReconciliations } from './RunReconciliations'
import type { RunReconciliations as Reconciliations } from '../api/types'

const state = vi.hoisted(() => ({
  phases: ['R0a', 'R0b'] as string[],
  enabledCalls: [] as boolean[],
  data: undefined as Reconciliations | undefined,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}))

vi.mock('../../r0a/api/queries', () => ({
  useWorkBootstrap: () => ({ data: { phases: state.phases } }),
}))

vi.mock('../api/queries', () => ({
  useWorkRunReconciliations: (_runId: string | undefined, enabled: boolean) => {
    state.enabledCalls.push(enabled)
    return { data: state.data }
  },
}))

const document = (over: Partial<Reconciliations> = {}): Reconciliations => ({
  org_id: 'org-1',
  run_id: 'run-1',
  task_id: 'task-1',
  run_state: 'active',
  wait_reason: 'reconcile',
  blocking: { new_run: false, acceptance: false },
  items: [],
  ...over,
})

beforeEach(() => {
  state.phases = ['R0a', 'R0b']
  state.enabledCalls = []
  state.data = undefined
})

afterEach(cleanup)

describe('RunReconciliations', () => {
  it('does not read the v2 face when the org lacks the R0b phase', () => {
    state.phases = ['R0a']
    state.data = document({
      items: [
        {
          operation_id: 'op-1',
          kind: 'model',
          operation_state: 'unknown',
          reconcile_requested_at: '2026-11-22T10:00:00Z',
          waited_seconds: 42,
          resolution_state: 'pending',
          evidence_sources: [],
          ticket_id: null,
          has_authoritative_evidence: false,
          contact_path: 'wait_for_reconciliation',
        },
      ],
    })
    const { container } = render(<RunReconciliations runId="run-1" />)
    expect(state.enabledCalls).toEqual([false])
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing for a run with no waiting operation', () => {
    state.data = document()
    const { container } = render(<RunReconciliations runId="run-1" />)
    expect(state.enabledCalls).toEqual([true])
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the wait clock, J38 state, authority, evidence and contact path', () => {
    state.data = document({
      items: [
        {
          operation_id: 'op-1',
          kind: 'model',
          operation_state: 'unresolved',
          reconcile_requested_at: '2026-11-22T10:00:00Z',
          waited_seconds: 42,
          resolution_state: 'evidence_exhausted',
          evidence_sources: ['provider_log', 'receipt'],
          ticket_id: 'OPS-7',
          has_authoritative_evidence: true,
          contact_path: 'operator_ticket',
        },
      ],
    })
    render(<RunReconciliations runId="run-1" />)
    expect(screen.getByText('task.reconciliations')).toBeTruthy()
    expect(
      screen.getByText('operationState.unresolved:{"defaultValue":"unresolved"}')
    ).toBeTruthy()
    expect(
      screen.getByText('task.reconciliationsWaited:{"seconds":42}')
    ).toBeTruthy()
    expect(
      screen.getByText('task.reconciliationsState.evidence_exhausted')
    ).toBeTruthy()
    expect(screen.getByText('task.reconciliationsAuthority')).toBeTruthy()
    expect(
      screen.getByText(
        'task.reconciliationsEvidence:{"sources":"provider_log, receipt"}'
      )
    ).toBeTruthy()
    expect(
      screen.getByText('task.reconciliationsTicket:{"ticket":"OPS-7"}')
    ).toBeTruthy()
    expect(
      screen.getByText('task.reconciliationsContact.operator_ticket')
    ).toBeTruthy()
  })

  it('states both blocking outcomes when the server reports them', () => {
    state.data = document({
      blocking: { new_run: true, acceptance: true },
      items: [
        {
          operation_id: 'op-1',
          kind: 'tool',
          operation_state: 'unknown',
          reconcile_requested_at: null,
          waited_seconds: null,
          resolution_state: 'downgraded_readonly',
          evidence_sources: [],
          ticket_id: null,
          has_authoritative_evidence: false,
          contact_path: 'wait_for_late_evidence',
        },
      ],
    })
    render(<RunReconciliations runId="run-1" />)
    expect(
      screen.getByText(
        'task.reconciliationsBlockNewRun · task.reconciliationsBlockAcceptance'
      )
    ).toBeTruthy()
    expect(screen.getByText('task.reconciliationsNoClock')).toBeTruthy()
    expect(screen.getByText('task.reconciliationsNoAuthority')).toBeTruthy()
    expect(screen.getByText('task.reconciliationsNoEvidence')).toBeTruthy()
    expect(
      screen.getByText('task.reconciliationsContact.wait_for_late_evidence')
    ).toBeTruthy()
  })
})