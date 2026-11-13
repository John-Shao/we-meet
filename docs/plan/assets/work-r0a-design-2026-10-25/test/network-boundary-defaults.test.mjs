// 2026-11-13, review batch B4: the Work control plane has no NetworkPolicy of its own - it is
// systemd units plus entry manifests - so its whole in-repo boundary is (a) which address each
// listener binds by default and (b) the meet chart's backend policy, which ships disabled and is
// turned on by one environment file. Neither had a machine reader: `grep -rln networkPolicy
// docs/plan/assets/` and the same for LISTEN_ADDR both returned zero files, and the python chart
// test that looks like coverage (`deploy/aliyun/test_ai_pool.py:61`) passes
// `--set backend.networkPolicy.enabled=true`, so it fabricates the flag and says nothing about the
// shipped default. A default silently flipped to 0.0.0.0, or the prod override dropped, would not
// have red anything.
//
// Deliberately NOT asserted here: what the pilot host actually binds right now. That lives in
// /etc/work/work-api.env on the machine, not in this repo, and work-api's production bind is a
// documented exception (0.0.0.0:8080 per the entry manifest and the host-wire decision). The cloud
// security group that keeps public 8080 closed has no carrier in this repo at all; that gap is
// registered in the ledger, and this guard pins the repo-side half only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..', '..');
const WORK = join(REPO, 'src', 'work');
const ECS = join(WORK, 'deploy', 'ecs');
const HELM = join(REPO, 'src', 'helm');
const read = (p) => readFileSync(p, 'utf8');
const lines = (p) => read(p).split(/\r?\n/);

function yamlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...yamlFiles(p));
    else if (/\.ya?ml$/.test(entry)) out.push(p);
  }
  return out;
}

// --- shipped env templates: every *_LISTEN_ADDR they define, per file -------------------------

const EXAMPLES = [
  'work-api.env.example',
  'work-authz.env.example',
  'work-content-proxy.env.example',
  'work-egress.env.example',
  'work-runtime.env.example',
];

function shippedAddresses() {
  const pairs = [];
  for (const file of EXAMPLES) {
    const path = join(ECS, file);
    assert.ok(existsSync(path), `${file} must still ship - it is the template the host env is copied from`);
    for (const line of lines(path)) {
      const m = line.match(/^([A-Z0-9_]*LISTEN_ADDR)=(\S+)\s*$/);
      if (m) pairs.push({ file, env: m[1], value: m[2] });
    }
  }
  return pairs;
}

// --- the code default that applies when the env var is unset ----------------------------------

// Shapes that exist in this tree, each anchored on the env var name so no address is copied into
// this file: envOrDefault("V", "lit"), envOrDefault("V", pkg.Ident) with the constant resolved from
// the same source set, firstEnv([...]) ?? 'lit', and os.Getenv("V") followed by an empty-check
// assignment. Comment lines are stripped first - the runtime server's header block names its own
// default, and reading that prose as the code default would make this guard self-confirming.
function codeDefaults(varName, files) {
  const found = new Set();
  for (const file of files) {
    const text = read(file)
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|#)/.test(l))
      .join('\n');
    let m = text.match(new RegExp(`envOrDefault\\(\\s*"${varName}"\\s*,\\s*"([^"]+)"`));
    if (m) found.add(m[1]);
    m = text.match(new RegExp(`envOrDefault\\(\\s*"${varName}"\\s*,\\s*([A-Za-z0-9_.]+)\\s*\\)`));
    if (m) {
      const ident = m[1].split('.').pop();
      for (const inner of files) {
        const c = read(inner).match(new RegExp(`\\b${ident}\\s*=\\s*"([^"]+)"`));
        if (c) found.add(c[1]);
      }
    }
    m = text.match(new RegExp(`${varName}[\\s\\S]{0,160}?\\?\\?\\s*'([^']+)'`));
    if (m) found.add(m[1]);
    m = text.match(new RegExp(
      `os\\.Getenv\\(\\s*"${varName}"\\s*\\)[\\s\\S]{0,60}?\\w+\\s*==\\s*""\\s*\\{[\\s\\S]{0,60}?\\w+\\s*=\\s*"([^"]+)"`));
    if (m) found.add(m[1]);
  }
  return [...found];
}

// Each listener's default is resolved from the sources that can legitimately hold it, so drift is
// caught whichever side of the pair moved.
const SOURCES = {
  WORK_LISTEN_ADDR: [join(WORK, 'cmd/work-api/main.go')],
  WORK_AUTHZ_LISTEN_ADDR: [join(WORK, 'cmd/work-authz/main.go')],
  WORK_CONTENT_PROXY_LISTEN_ADDR: [
    join(WORK, 'cmd/work-content-proxy/main.go'),
    join(WORK, 'internal/contentproxy/contentproxy.go'),
  ],
  WORK_EGRESS_LISTEN_ADDR: [
    join(WORK, 'cmd/work-egress/main.go'),
    join(WORK, 'internal/egressservice/egressservice.go'),
  ],
  WORK_RUNTIME_LISTEN_ADDR: [join(WORK, 'node', 'bin', 'work-runtime-server.mjs')],
};

test('every shipped listen-address template matches the default in its own code', () => {
  const pairs = shippedAddresses();
  // 下限: five services publish a bind address; fewer means a template lost its line, which is not
  // a pass.
  assert.ok(pairs.length >= 5, `expected at least 5 *_LISTEN_ADDR templates, found ${pairs.length}`);
  for (const { file, env, value } of pairs) {
    const sources = SOURCES[env];
    assert.ok(sources,
      `${file} sets ${env}, but this guard has no source mapping for it - add one, do not let a new listener go unpinned`);
    const rel = sources.map((s) => s.slice(REPO.length + 1));
    const defaults = codeDefaults(env, sources);
    assert.equal(defaults.length, 1,
      `${env}: resolving its default from ${rel.join(' + ')} gave [${defaults.join(' | ')}] - this guard needs ` +
      'exactly one, otherwise it cannot say what the code does when the env var is unset');
    assert.equal(value, defaults[0],
      `${file} ships ${env}=${value} but the code default is ${defaults[0]}: operators copy the template, so a ` +
      'disagreement means the shipped default is not the default that was reviewed');
  }
});

test('every shipped bind default is loopback, and work-api is the only published exception', () => {
  for (const { file, env, value } of shippedAddresses()) {
    assert.ok(value.startsWith('127.0.0.1:'),
      `${file} ships ${env}=${value}: a non-loopback shipped default binds every interface, which is a posture ` +
      'change and must not arrive as a template edit');
  }
  // work-api is reached through the k3s ingress, so its production bind is 0.0.0.0 by decision. That
  // exception has to stay written down in both places that carry it.
  const entry = join(ECS, 'work-api-entry.yaml');
  assert.ok(existsSync(entry), 'the work-api entry manifest is the only published Work route - it must exist');
  assert.match(read(entry), /work-api listens on 0\.0\.0\.0:8080/,
    'the manifest must keep stating the bind address it assumes, or the 127.0.0.1 template and the ingress disagree silently');
  const decision = read(join(REPO, 'docs', 'plan', 'work-r0a-host-wire-decision-2026-10-28.md'));
  assert.match(decision, /改为监听 `0\.0\.0\.0:8080`/,
    'the 0.0.0.0 bind is a signed exception; without that sentence the manifest asserts an undecided posture');
});

test('no manifest in the deployment tree publishes an internal mTLS port', () => {
  const corpus = [...yamlFiles(join(WORK, 'deploy')), ...yamlFiles(join(REPO, 'deploy', 'aliyun'))]
    .map((f) => ({ f, t: read(f) }))
    .filter(({ t }) => /^kind:/m.test(t));
  assert.ok(corpus.length >= 4,
    `expected at least 4 k8s manifests to scan, found ${corpus.length} - an empty corpus passes this trivially`);
  // Positive control: the work-api NodePort is in there, so a zero-hit result below is absence of
  // exposure, not absence of reading.
  assert.ok(corpus.some(({ t }) => /30080/.test(t)),
    'the corpus must include the work-api entry (NodePort 30080) or this scan proves nothing');
  for (const { f, t } of corpus) {
    // Anchored on a port key: `8445` also occurs inside a hex secret elsewhere in the repo, and a
    // bare number match would make this guard red for the wrong reason and get it disabled.
    const published = t.match(/^\s*(?:-\s*)?(?:port|targetPort|nodePort|hostPort):\s*"?(844[3-6])\b/m);
    assert.equal(published, null,
      `${f.slice(REPO.length + 1)} publishes ${published && published[1]} - authz/content-proxy/egress/runtime are ` +
      'reached over loopback by the units on this host, so exposing one is a new attack surface, not a config tweak');
  }
});

// --- meet chart: the policy ships disabled, exactly one environment turns it on ----------------

// Indentation-scoped lookup: a flat grep for `enabled: true` also matches aiBackend and
// voiceprintSampler.networkPolicy, which is how a chart guard ends up asserting nothing.
function scalarAt(text, path) {
  const stack = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(raw)) continue;
    const m = raw.match(/^(\s*)([\w"-.]+):\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ indent, key: m[2].replace(/"/g, '') });
    if (stack.length !== path.length) continue;
    if (!path.every((seg, i) => stack[i].key === seg)) continue;
    return m[3].trim().replace(/^"|"$/g, '');
  }
  return null;
}

test('the meet chart keeps backend.networkPolicy disabled by default', () => {
  const values = read(join(HELM, 'meet', 'values.yaml'));
  // Parser positive control: same depth, same file, sibling section. If the lookup breaks, it keeps
  // resolving this while `networkPolicy` reads as absent - which would look like a passing default.
  assert.equal(scalarAt(values, ['backend', 'service', 'port']), '80',
    'the indentation lookup must resolve backend.service.port=80 before its answers about networkPolicy mean anything');
  assert.equal(scalarAt(values, ['backend', 'networkPolicy', 'enabled']), 'false',
    'backend.networkPolicy.enabled must stay false in the chart: every environment inherits this file, and a ' +
    'default-on policy with the wrong nodeCIDR blackholes the agents');
  assert.equal(scalarAt(values, ['backend', 'networkPolicy', 'nodeCIDR']), '',
    'with no policy by default the CIDR must stay empty rather than ship a live node address to every environment');
  assert.notEqual(scalarAt(values, ['aiBackend', 'enabled']), null,
    'the path lookup must resolve sibling sections too, or a broken parser looks like a passing default');
});

test('the production environment turns it on with a single-host CIDR', () => {
  const prod = read(join(HELM, 'env.d', 'aliyun-prod', 'values.meet.yaml'));
  assert.equal(scalarAt(prod, ['backend', 'networkPolicy', 'enabled']), 'true',
    'prod is the only carrier of this boundary; if the override goes away the policy is silently off again');
  const cidr = scalarAt(prod, ['backend', 'networkPolicy', 'nodeCIDR']);
  assert.match(cidr ?? '', /^\d+\.\d+\.\d+\.\d+\/32$/,
    `prod nodeCIDR = ${JSON.stringify(cidr)}: ingress-nginx is hostNetwork, so this must be exactly one node ` +
    'address as a /32 - a wider mask admits everything in the range');
  assert.equal(scalarAt(prod, ['aiBackend', 'enabled']), 'true',
    'and the override file still has to parse as the same nesting shape this guard reads');
});

test('the template really gates on the flag and refuses a policy that locks out the backend', () => {
  const tpl = read(join(HELM, 'meet', 'templates', 'backend_network_policy.yaml'));
  assert.match(tpl, /\{\{-?\s*if \$networkPolicy\.enabled\s*\}\}/,
    'enabled must be the switch, otherwise the chart default assertion above guards nothing');
  assert.match(tpl, /must include backend/,
    'the fail() guard is what stops an override writing a policy that denies the backend its own ingress');
  assert.match(tpl, /cidr:\s*\{\{\s*\$networkPolicy\.nodeCIDR\s*\|\s*quote\s*\}\}/,
    'the node CIDR must reach the rendered peer list verbatim; if it stops being read, prod is relying on a policy that no longer carries it');
});

test('the python chart test is recorded as supplying its own flag', () => {
  // This assertion exists so nobody reads test_ai_pool.py as coverage of the default. If that file
  // ever stops setting the flag, the finding below is stale and this test says so.
  const py = read(join(REPO, 'deploy', 'aliyun', 'test_ai_pool.py'));
  assert.match(py, /"backend\.networkPolicy\.enabled=true"/,
    'test_ai_pool.py renders the chart with the flag forced on - this node gate, not that test, pins the default');
  assert.match(py, /172\.16\.0\.4\/32/, 'and it asserts the same /32 shape as prod');
});
