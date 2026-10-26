// Pilot operations model: golden-task checks, pilot metrics from content-free
// events, and cutover plan validation. Deterministic; no network.

import fs from 'node:fs';

const read = (rel) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));

export function loadPilot() {
  return {
    golden: read('./golden-tasks.json'),
    metrics: read('./pilot-metrics.json'),
    cutover: read('./cutover-plan.json'),
    checklist: read('./pilot-checklist.json'),
  };
}

export function emittedEventTypes(schemaSql) {
  const literal = [...schemaSql.matchAll(/'((?:task|run|artifact|operation|approval)\.[a-z_]+)'/g)].map((m) => m[1]);
  // run terminal events are composed as 'run.' || NEW.state in a trigger.
  const composed = /'run\.' \|\| NEW\.state/.test(schemaSql) ? ['run.succeeded', 'run.failed', 'run.canceled'] : [];
  return new Set([...literal, ...composed]);
}

export function validateGolden(golden, templates) {
  const errors = [];
  const byId = new Map(templates.map((t) => [t.id, t]));
  for (const id of golden.templates) if (!byId.has(id)) errors.push(`unknown template ${id}`);
  const covered = new Set(golden.tasks.map((t) => t.template));
  for (const id of golden.templates) if (!covered.has(id)) errors.push(`template ${id} has no golden task`);
  const ids = new Set();
  for (const task of golden.tasks) {
    if (ids.has(task.id)) errors.push(`duplicate ${task.id}`);
    ids.add(task.id);
    const template = byId.get(task.template);
    if (template && JSON.stringify(template.sections) !== JSON.stringify(task.required_sections)) {
      errors.push(`${task.id} sections drift from ${task.template}`);
    }
    if (!(task.length_chars[0] > 0 && task.length_chars[1] > task.length_chars[0])) {
      errors.push(`${task.id} length range`);
    }
    for (const check of task.checks) if (!CHECKS[check]) errors.push(`${task.id} unknown check ${check}`);
    if (/(https?:|@|\d{11})/.test(task.goal)) errors.push(`${task.id} goal must be synthetic`);
  }
  return errors;
}

const headings = (md) => [...md.matchAll(/^#{1,3}\s*(.+?)\s*$/gm)].map((m) => m[1]);

// Each check returns true/false, or 'manual' when a reviewer must judge.
export const CHECKS = {
  sections_present: (md, task) => task.required_sections.every((s) => headings(md).includes(s)),
  length_in_range: (md, task) => {
    const n = [...md].length;
    return n >= task.length_chars[0] && n <= task.length_chars[1];
  },
  no_fabricated_links: (md) => !/https?:\/\//.test(md),
  no_prompt_echo: (md) => !/(system prompt|你是一个|作为一个AI|as an ai)/i.test(md),
  has_recommendation: (md) => /建议/.test(md),
  steps_numbered: (md) => /^\s*1[.、]/m.test(md),
  no_named_people: () => 'manual',
  todos_have_owner_role: () => 'manual',
  no_new_facts: () => 'manual',
};

export function evaluateGoldenRun(task, markdown) {
  const failed = [];
  const manual = [];
  for (const check of task.checks) {
    const result = CHECKS[check](markdown, task);
    if (result === 'manual') manual.push(check);
    else if (!result) failed.push(check);
  }
  return { passed: failed.length === 0, failed, manual };
}

// runs: [{ taskId, passed, costCents, endToEndSeconds, reviewerApproved }]
export function evaluateGoldenSuite(golden, runs) {
  const rule = golden.pass_rule;
  const perTask = golden.tasks.map((task) => {
    const mine = runs.filter((r) => r.taskId === task.id);
    const passing = mine.filter(
      (r) => r.passed && r.reviewerApproved !== false && r.costCents <= rule.max_cost_cents_per_run,
    ).length;
    return {
      id: task.id,
      runs: mine.length,
      passing,
      passed: mine.length >= rule.runs_per_task && passing >= rule.min_passing_runs,
    };
  });
  const durations = runs.map((r) => r.endToEndSeconds).sort((a, b) => a - b);
  const p95 = durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)] : null;
  const ratio = perTask.filter((t) => t.passed).length / perTask.length;
  return {
    perTask,
    passRatio: ratio,
    p95Seconds: p95,
    passed: ratio >= rule.suite_min_pass_ratio && p95 !== null && p95 <= rule.max_end_to_end_seconds_p95,
  };
}

// events: [{ org_id, task_id, subject_id?, type, at (ms), payload }]
export function computeMetrics(events, { enabledAt, activationThreshold = 3 }) {
  const ofType = (type) => events.filter((e) => e.type === type);
  const fortnight = enabledAt + 14 * 86_400_000;
  const activators = new Set(
    ofType('task.submitted').filter((e) => e.at >= enabledAt && e.at <= fortnight).map((e) => e.subject_id),
  );
  const succeeded = ofType('run.succeeded').length;
  const failed = ofType('run.failed').length;
  const awaiting = new Set(ofType('task.awaiting_acceptance').map((e) => e.task_id));
  const completed = ofType('task.completed');
  const acceptedByVersion = new Set(
    completed.filter((e) => e.payload?.basis === 'version' && awaiting.has(e.task_id)).map((e) => e.task_id),
  );
  const submittedAt = new Map(ofType('task.submitted').map((e) => [e.task_id, e.at]));
  const firstArtifact = new Map();
  for (const e of ofType('artifact.published')) {
    if (!firstArtifact.has(e.task_id) || e.at < firstArtifact.get(e.task_id)) firstArtifact.set(e.task_id, e.at);
  }
  const ttfa = [...firstArtifact]
    .filter(([taskId]) => submittedAt.has(taskId))
    .map(([taskId, at]) => (at - submittedAt.get(taskId)) / 1000)
    .sort((a, b) => a - b);
  const median = ttfa.length
    ? ttfa.length % 2
      ? ttfa[(ttfa.length - 1) / 2]
      : (ttfa[ttfa.length / 2 - 1] + ttfa[ttfa.length / 2]) / 2
    : null;
  return {
    activated: activators.size >= activationThreshold,
    activators: activators.size,
    technicalSuccessRate: succeeded + failed ? succeeded / (succeeded + failed) : null,
    acceptanceRate: awaiting.size ? acceptedByVersion.size / awaiting.size : null,
    reasonCompletionShare: completed.length
      ? completed.filter((e) => e.payload?.basis === 'reason').length / completed.length
      : null,
    timeToFirstArtifactP50Seconds: median,
  };
}

export function validateMetrics(metrics, emitted) {
  const errors = [];
  for (const type of metrics.event_types) if (!emitted.has(type)) errors.push(`event ${type} is not emitted by D1`);
  const gates = Object.entries(metrics.metrics).filter(([, m]) => m.go_gate);
  for (const [name, m] of gates) if (m.target === null || m.target === undefined) errors.push(`${name} gate without target`);
  return errors;
}

export function validateCutover(cutover, checklist) {
  const errors = [];
  const ids = new Set(checklist.items.map((i) => i.id));
  const states = Object.keys(cutover.states);
  for (const [name, state] of Object.entries(cutover.states)) {
    if (!state.kill_switch_compatible) errors.push(`${name} not kill-switch compatible`);
  }
  for (const t of cutover.transitions) {
    if (!states.includes(t.from) || !states.includes(t.to)) errors.push(`bad transition ${t.from}->${t.to}`);
    for (const id of t.requires_checklist ?? []) if (!ids.has(id)) errors.push(`unknown checklist ${id}`);
    if (!t.approvers?.length) errors.push(`${t.from}->${t.to} has no approver`);
    if (t.to === 'rolled_back' && t.requires_checklist?.length) errors.push('rollback must not wait on checklist');
  }
  const enable = cutover.transitions.find((t) => t.from === 'off' && t.to === 'pilot_on');
  const blocking = checklist.items.filter((i) => i.blocking && i.category === 'migration').map((i) => i.id);
  for (const id of blocking) {
    if (!enable?.requires_checklist.includes(id) && !['C28', 'C29'].includes(id)) {
      errors.push(`enable transition misses blocking migration item ${id}`);
    }
  }
  if (cutover.transitions.some((t) => t.from === 'rolled_back' && t.to === 'pilot_on' && !t.approvers.includes('product'))) {
    errors.push('re-enable must be explicit with product approval');
  }
  if (!cutover.forbidden.some((f) => /dual-write/.test(f))) errors.push('dual-write must be forbidden');
  return errors;
}

// Simple gate: can this org move between states given checklist statuses?
export function canTransition(cutover, checklist, from, to) {
  const t = cutover.transitions.find((x) => x.from === from && x.to === to);
  if (!t) return { allowed: false, missing: ['no_such_transition'] };
  const status = new Map(checklist.items.map((i) => [i.id, i.status]));
  const missing = (t.requires_checklist ?? []).filter((id) => !['done', 'waived'].includes(status.get(id)));
  return { allowed: missing.length === 0, missing };
}
