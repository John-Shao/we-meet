#!/usr/bin/env node
/**
 * Scans runtime logs/traces for secrets and user content.
 *
 * This is the executable half of the no-content/no-secret logging policy. It
 * never prints raw matches: findings carry only a redacted line so the scanner
 * itself cannot become the leak. Use synthetic canaries in staging to prove the
 * path under test does not log prompts or artifact bodies.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const RULES = [
  {
    id: 'secret.openai_like',
    severity: 'fail',
    pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    id: 'secret.anthropic_like',
    severity: 'fail',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  },
  {
    id: 'secret.bearer',
    severity: 'fail',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
  },
  {
    id: 'secret.env_assignment',
    severity: 'fail',
    pattern:
      /\b(?:DASHSCOPE_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|DOUBAO_API_KEY|DEEPSEEK_API_KEY|API_KEY|SECRET_KEY|ACCESS_TOKEN)\s*[=:]\s*["']?[^\s"']{8,}/gi,
  },
  {
    id: 'secret.aws_access_key',
    severity: 'fail',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    id: 'secret.private_key',
    severity: 'fail',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  },
  {
    id: 'auth.session_cookie',
    severity: 'fail',
    pattern: /\bwe_meet_session=[^;\s]+/g,
  },
  {
    id: 'content.field',
    severity: 'fail',
    pattern:
      /\b(?:goal|background|prompt|messages|completion|artifact_content|content)\s*[=:]\s*["']?[^\s"']{12,}/gi,
  },
  {
    id: 'pii.email',
    severity: 'warn',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  },
];

const SCAN_EXTENSIONS = new Set(['.log', '.jsonl', '.ndjson', '.out', '.trace', '.txt']);
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '__pycache__']);

export function redact(value) {
  const text = String(value);
  if (text.length <= 8) return '[redacted]';
  return `${text.slice(0, 3)}…${text.slice(-2)}`;
}

function applyRules(line, canaries) {
  const matches = [];
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of line.matchAll(rule.pattern)) {
      matches.push({
        rule: rule.id,
        severity: rule.severity,
        value: match[0],
        index: match.index ?? 0,
      });
    }
  }
  for (const canary of canaries) {
    if (!canary) continue;
    let index = line.indexOf(canary);
    while (index !== -1) {
      matches.push({
        rule: 'content.canary',
        severity: 'fail',
        value: canary,
        index,
      });
      index = line.indexOf(canary, index + canary.length);
    }
  }
  return matches;
}

function redactLine(line, matches) {
  let output = line;
  const ordered = [...matches].sort((a, b) => b.index - a.index);
  for (const match of ordered) {
    output =
      output.slice(0, match.index) +
      redact(match.value) +
      output.slice(match.index + match.value.length);
  }
  return output.length > 240 ? `${output.slice(0, 240)}…` : output;
}

/**
 * @param {string} text
 * @param {{ source?: string, canaries?: string[], failOnWarning?: boolean }} [options]
 */
export function scanText(text, options = {}) {
  const source = options.source ?? '<text>';
  const canaries = options.canaries ?? [];
  const findings = [];
  const lines = String(text).split(/\r?\n/);

  lines.forEach((line, index) => {
    const matches = applyRules(line, canaries);
    if (matches.length === 0) return;
    const seen = new Set();
    for (const match of matches) {
      // One finding per rule per line is enough; do not duplicate a repeated
      // token and inflate the report.
      if (seen.has(match.rule)) continue;
      seen.add(match.rule);
      findings.push({
        rule: match.rule,
        severity: match.severity,
        source,
        line: index + 1,
        preview: redactLine(line, matches),
      });
    }
  });

  const bySeverity = { fail: 0, warn: 0 };
  const byRule = {};
  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
    byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1;
  }
  return {
    files: 1,
    lines: lines.length,
    findings,
    bySeverity,
    byRule,
    failed: bySeverity.fail > 0 || (options.failOnWarning === true && bySeverity.warn > 0),
  };
}

function collectFiles(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  if (!stat.isDirectory()) return [];
  const files = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(child));
    else if (SCAN_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(child);
    }
  }
  return files;
}

/**
 * @param {string[]} targets
 * @param {{ canaries?: string[], failOnWarning?: boolean }} [options]
 */
export function scanPaths(targets, options = {}) {
  const files = targets.flatMap(collectFiles).sort();
  const aggregate = {
    files: files.length,
    lines: 0,
    findings: [],
    bySeverity: { fail: 0, warn: 0 },
    byRule: {},
    failed: false,
  };
  for (const file of files) {
    const result = scanText(fs.readFileSync(file, 'utf8'), {
      source: path.relative(process.cwd(), file) || file,
      canaries: options.canaries,
      failOnWarning: options.failOnWarning,
    });
    aggregate.lines += result.lines;
    aggregate.findings.push(...result.findings);
    aggregate.bySeverity.fail += result.bySeverity.fail;
    aggregate.bySeverity.warn += result.bySeverity.warn;
    for (const [rule, count] of Object.entries(result.byRule)) {
      aggregate.byRule[rule] = (aggregate.byRule[rule] ?? 0) + count;
    }
    aggregate.failed ||= result.failed;
  }
  return aggregate;
}

function main() {
  const args = process.argv.slice(2);
  const paths = [];
  const canaries = [];
  let json = false;
  let strict = false;

  for (const arg of args) {
    if (arg === '--json') json = true;
    else if (arg === '--strict') strict = true;
    else if (arg.startsWith('--canary=')) {
      canaries.push(arg.slice('--canary='.length));
    } else if (arg === '--canary') {
      throw new Error('use --canary=TOKEN so the value is not confused with a path');
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option ${arg}`);
    } else {
      paths.push(arg);
    }
  }
  if (paths.length === 0) {
    console.error('usage: node log-scan.mjs [--json] [--strict] [--canary=TOKEN] <file-or-dir>...');
    process.exit(2);
  }

  const result = scanPaths(paths, { canaries, failOnWarning: strict });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `scanned ${result.files} files/${result.lines} lines; fail=${result.bySeverity.fail} warn=${result.bySeverity.warn}`,
    );
    for (const finding of result.findings) {
      console.log(
        `${finding.severity} ${finding.rule} ${finding.source}:${finding.line} ${finding.preview}`,
      );
    }
    console.log(result.failed ? 'log-scan: FAIL' : 'log-scan: clean');
  }
  process.exit(result.failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
