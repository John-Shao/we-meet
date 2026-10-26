#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  RULES_PATH,
  loadTelemetry,
  renderRules,
  validateTelemetry,
} from './telemetry-model.mjs';

function main() {
  const { contract, slos } = loadTelemetry();
  const rendered = renderRules(contract);
  const validation = validateTelemetry({
    contract,
    slos,
    rulesYaml: rendered,
  });
  if (validation.errors.length > 0) {
    console.error(validation.errors.join('\n'));
    process.exit(1);
  }

  if (process.argv.includes('--check')) {
    const current = fs.existsSync(RULES_PATH) ? fs.readFileSync(RULES_PATH, 'utf8') : '';
    if (current !== rendered) {
      console.error(
        'prometheus-rules.yaml is out of date. Run: node generate-telemetry.mjs',
      );
      process.exit(1);
    }
    console.log('prometheus-rules.yaml up to date');
    return;
  }

  fs.writeFileSync(RULES_PATH, rendered, 'utf8');
  console.log(
    `wrote prometheus-rules.yaml (${validation.summary.records} records, ${validation.summary.alerts} alerts)`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
