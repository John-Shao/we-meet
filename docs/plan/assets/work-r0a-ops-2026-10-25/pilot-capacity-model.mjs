/**
 * R0a pilot capacity model.
 *
 * This is a sizing aid, not a production capacity proof. Inputs are explicit
 * and limits are pilot thresholds. The model checks whether the pilot
 * assumptions fit the current smoke-tested envelope.
 */
import { pathToFileURL } from 'node:url';

export const DEFAULT_INPUTS = {
  orgs: 3,
  seats: 20,
  activeUsers: 15,
  tasksPerUserPerDay: 2,
  runsPerTask: 1.2,
  modelOpsPerRun: 3,
  avgRunMinutes: 4,
  peakConcurrency: 10,
  inputTokensPerOp: 8000,
  outputTokensPerOp: 4000,
  inputBytesPerRun: 8000,
  outputBytesPerRun: 8000,
  checkpointBytesPerOp: 24000,
  eventsPerRun: 8,
  retentionDays: 365,
};

export const DEFAULT_LIMITS = {
  maxConcurrentRuns: 10,
  providerRequestsPerMinute: 60,
  providerTokensPerDay: 2000000,
  dbReservationsPerSecond: 20,
  outboxEventsPerSecond: 10,
  workflowStartsPerMinute: 20,
  contentRetentionGb: 10,
};

function assertPositive(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`invalid input: ${name}`);
  }
}

export function computeCapacity(inputs = DEFAULT_INPUTS) {
  for (const [name, value] of Object.entries(inputs)) assertPositive(name, value);
  if (inputs.avgRunMinutes <= 0) throw new Error('invalid input: avgRunMinutes');
  if (inputs.activeUsers > inputs.seats) throw new Error('invalid input: activeUsers exceeds seats');
  if (inputs.peakConcurrency > inputs.seats) throw new Error('invalid input: peakConcurrency exceeds seats');

  const tasksPerDay = inputs.activeUsers * inputs.tasksPerUserPerDay;
  const runsPerDay = tasksPerDay * inputs.runsPerTask;
  const modelOpsPerDay = runsPerDay * inputs.modelOpsPerRun;
  const peakRunsPerMinute = inputs.peakConcurrency / inputs.avgRunMinutes;
  const providerPeakRpm = (inputs.peakConcurrency * inputs.modelOpsPerRun) / inputs.avgRunMinutes;
  const dbReservationsPeakPerSec = providerPeakRpm / 60;
  const outboxEventsPeakPerSec =
    (inputs.peakConcurrency * inputs.eventsPerRun) / (inputs.avgRunMinutes * 60);
  const workflowStartsPeakPerMinute = peakRunsPerMinute;
  const tokensPerDay =
    runsPerDay * inputs.modelOpsPerRun * (inputs.inputTokensPerOp + inputs.outputTokensPerOp);
  const contentBytesPerRun =
    inputs.inputBytesPerRun +
    inputs.outputBytesPerRun +
    inputs.checkpointBytesPerOp * inputs.modelOpsPerRun;
  const contentBytesPerDay = runsPerDay * contentBytesPerRun;
  const contentRetentionGb = (contentBytesPerDay * inputs.retentionDays) / 1e9;

  return {
    tasksPerDay,
    runsPerDay,
    modelOpsPerDay,
    peakRunsPerMinute,
    providerPeakRpm,
    dbReservationsPeakPerSec,
    outboxEventsPeakPerSec,
    workflowStartsPeakPerMinute,
    tokensPerDay,
    monthlyTokens: tokensPerDay * 30,
    contentBytesPerRun,
    contentBytesPerDay,
    contentRetentionGb,
  };
}

export function evaluateCapacity(inputs = DEFAULT_INPUTS, limits = DEFAULT_LIMITS) {
  const metrics = computeCapacity(inputs);
  const checks = [
    {
      metric: 'peakConcurrency',
      value: inputs.peakConcurrency,
      limit: limits.maxConcurrentRuns,
      pass: inputs.peakConcurrency <= limits.maxConcurrentRuns,
    },
    {
      metric: 'providerPeakRpm',
      value: metrics.providerPeakRpm,
      limit: limits.providerRequestsPerMinute,
      pass: metrics.providerPeakRpm <= limits.providerRequestsPerMinute,
    },
    {
      metric: 'providerTokensPerDay',
      value: metrics.tokensPerDay,
      limit: limits.providerTokensPerDay,
      pass: metrics.tokensPerDay <= limits.providerTokensPerDay,
    },
    {
      metric: 'dbReservationsPeakPerSec',
      value: metrics.dbReservationsPeakPerSec,
      limit: limits.dbReservationsPerSecond,
      pass: metrics.dbReservationsPeakPerSec <= limits.dbReservationsPerSecond,
    },
    {
      metric: 'outboxEventsPeakPerSec',
      value: metrics.outboxEventsPeakPerSec,
      limit: limits.outboxEventsPerSecond,
      pass: metrics.outboxEventsPeakPerSec <= limits.outboxEventsPerSecond,
    },
    {
      metric: 'workflowStartsPeakPerMinute',
      value: metrics.workflowStartsPeakPerMinute,
      limit: limits.workflowStartsPerMinute,
      pass: metrics.workflowStartsPeakPerMinute <= limits.workflowStartsPerMinute,
    },
    {
      metric: 'contentRetentionGb',
      value: metrics.contentRetentionGb,
      limit: limits.contentRetentionGb,
      pass: metrics.contentRetentionGb <= limits.contentRetentionGb,
    },
  ];
  return {
    inputs,
    limits,
    metrics,
    checks,
    ok: checks.every((check) => check.pass),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(evaluateCapacity(), null, 2));
}
