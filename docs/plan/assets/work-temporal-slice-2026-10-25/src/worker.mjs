import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities.mjs';
import { CFG } from './db.mjs';

export async function startWorker({ workflowsFile = 'workflows.mjs' } = {}) {
  const connection = await NativeConnection.connect({ address: CFG.temporalAddress });
  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: CFG.taskQueue,
    workflowsPath: fileURLToPath(new URL(workflowsFile, import.meta.url)),
    activities,
  });
  const runPromise = worker.run();
  runPromise.catch((error) => {
    console.error('temporal worker stopped', error.message);
  });
  return {
    worker,
    connection,
    async shutdown() {
      await worker.shutdown();
      await runPromise.catch(() => {});
      await connection.close();
    },
  };
}
