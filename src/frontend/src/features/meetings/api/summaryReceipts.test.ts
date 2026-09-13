import { describe, expect, it } from 'vitest'
import { automationReceipt, summaryReceipt } from './summaryReceipts'

const payload = {
  operation: 'generate' as const,
  expected_revision: 1,
  expected_job_id: null,
  expected_attempt: null,
}
const receipt = {
  request_id: '11111111-1111-4111-8111-111111111111',
  replayed: true,
  dispatch_state: 'sent',
  job: {
    id: '22222222-2222-4222-8222-222222222222',
    status: 'succeeded',
    stage: 'final',
    attempt: 2,
    generation: 1,
    input_revision: 1,
    retryable: false,
    dispatch_pending: false,
    error_code: '',
    updated_at: '2026-09-13T00:00:00Z',
  },
}
describe('Summary write receipts', () => {
  it('accepts the latest status of an idempotently replayed job', () => {
    expect(summaryReceipt(receipt, payload)).toBe(receipt)
  })
  it.each([
    { attempt: 0 },
    { input_revision: 1.1 },
    { status: ['succeeded'] },
    { updated_at: 'invalid' },
    { id: 'not-a-uuid' },
    { retryable: undefined },
    { chunk_progress: { completed: 3, total: 2 } },
    { chunk_progress: { completed: 0, total: 33 } },
  ])('rejects unusable job coordinates %j', (job) => {
    expect(() =>
      summaryReceipt({ ...receipt, job: { ...receipt.job, ...job } }, payload)
    ).toThrow()
  })
  const result = {
    revision: 1,
    enabled: true,
    state: 'waiting',
    error_code: '',
  }
  const automation = {
    command_id: receipt.request_id,
    replayed: true,
    result,
    current: result,
  }
  it.each([
    undefined,
    {},
    { ...automation, replayed: undefined },
    { ...automation, result: { ...result, enabled: false } },
    { ...automation, result: { ...result, revision: 2 } },
    { ...automation, current: { ...result, revision: 0 } },
  ])('rejects missing or mismatched consent receipt %j', (value) => {
    expect(() =>
      automationReceipt(value, { enabled: true, expected_revision: 0 })
    ).toThrow()
  })
})
