import { describeWorkflow, closeRelay } from '../src/relay.mjs';
import { getTask } from '../src/api.mjs';
import { closePools } from '../src/db.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const workflowId = process.env.WORKFLOW_ID;
const taskId = process.env.TASK_ID;
if (!workflowId || !taskId) {
  console.log('PERSIST_READ {"ok":false,"error":"missing_ids"}');
  process.exit(2);
}

let description = null;
for (let attempt = 0; attempt < 20; attempt += 1) {
  try {
    description = await describeWorkflow(workflowId);
    break;
  } catch {
    await sleep(1000);
  }
}
const task = await getTask(taskId);
const result = {
  ok: description?.status?.name === 'COMPLETED' && task?.display_state === 'awaiting_acceptance',
  workflow_status: description?.status?.name ?? null,
  task_display: task?.display_state ?? null,
};
console.log(`PERSIST_READ ${JSON.stringify(result)}`);
if (!result.ok) process.exitCode = 1;
await closeRelay();
await closePools();
