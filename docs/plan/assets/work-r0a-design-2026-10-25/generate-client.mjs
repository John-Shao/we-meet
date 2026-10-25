#!/usr/bin/env node
/**
 * Generates the dependency-free runtime client from the R0a OpenAPI subset.
 *
 * The spec is the source of truth: operation ids, path/query/header params,
 * request body schema and success response schema are all read from
 * r0a-openapi-v1.yaml. `--check` fails when the committed client drifts, which
 * is what CI runs.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SPEC_PATH = path.join(HERE, 'r0a-openapi-v1.yaml');
export const CLIENT_PATH = path.join(HERE, 'r0a-client.mjs');
const TYPES_FILE = 'r0a-api-types.d.ts';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

function indentOf(line) {
  return line.match(/^ */)[0].length;
}

function stripQuotes(value) {
  return value.replace(/^["']|["']$/g, '');
}

function parseComponentParameters(lines, componentsStart) {
  const parameters = new Map();
  const start = lines.findIndex(
    (line, index) => index > componentsStart && /^  parameters:\s*$/.test(line),
  );
  if (start === -1) return parameters;

  let current = null;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (indentOf(line) === 0 && line.trim()) break;
    if (indentOf(line) === 2 && line.trim() && !line.startsWith('    ')) break;
    const key = line.match(/^    (\w+):\s*$/);
    if (key) {
      current = { key: key[1], name: null, in: null, required: false };
      parameters.set(key[1], current);
      continue;
    }
    if (!current) continue;
    const name = line.match(/^      name: (.+?)\s*$/);
    if (name) current.name = stripQuotes(name[1]);
    const location = line.match(/^      in: (\w+)\s*$/);
    if (location) current.in = location[1];
    const required = line.match(/^      required: (true|false)\s*$/);
    if (required) current.required = required[1] === 'true';
  }
  return parameters;
}

function parseSchemaNames(lines, componentsStart) {
  const names = new Set();
  const start = lines.findIndex(
    (line, index) => index > componentsStart && /^  schemas:\s*$/.test(line),
  );
  if (start === -1) return names;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (indentOf(line) === 0 && line.trim()) break;
    const key = line.match(/^    (\w+):\s*$/);
    if (key) names.add(key[1]);
  }
  return names;
}

function parseInlineParameter(block, index) {
  const name = block[index].match(/^        - name: (.+?)\s*$/);
  if (!name) return null;
  let location = null;
  let required = false;
  for (let i = index + 1; i < block.length; i += 1) {
    if (/^        - /.test(block[i])) break;
    const inMatch = block[i].match(/^          in: (\w+)\s*$/);
    if (inMatch) location = inMatch[1];
    const requiredMatch = block[i].match(/^          required: (true|false)\s*$/);
    if (requiredMatch) required = requiredMatch[1] === 'true';
  }
  return { name: stripQuotes(name[1]), in: location, required };
}

function parseOperation({ method, openapiPath, block }, componentParams, schemaNames) {
  const operationIdLine = block.find((line) => /^      operationId: \S+/.test(line));
  if (!operationIdLine) {
    throw new Error(`${method.toUpperCase()} ${openapiPath}: missing operationId`);
  }
  const operationId = operationIdLine.match(/^      operationId: (\S+)/)[1];
  const summaryLine = block.find((line) => /^      summary: /.test(line));
  const summary = summaryLine
    ? summaryLine.replace(/^      summary: /, '').trim()
    : '';

  const parameters = [];
  for (let i = 0; i < block.length; i += 1) {
    const ref = block[i].match(
      /^        - \$ref: "#\/components\/parameters\/(\w+)"/,
    );
    if (ref) {
      const component = componentParams.get(ref[1]);
      if (!component) {
        throw new Error(`${operationId}: unknown parameter component ${ref[1]}`);
      }
      parameters.push({
        name: component.name,
        in: component.in,
        required: component.required,
        component: ref[1],
      });
      continue;
    }
    if (/^        - name: /.test(block[i])) {
      const inline = parseInlineParameter(block, i);
      parameters.push({ ...inline, component: null });
    }
  }

  const requestIndex = block.findIndex((line) => /^      requestBody:/.test(line));
  let requestSchema = null;
  let requestRequired = false;
  if (requestIndex !== -1) {
    for (let i = requestIndex + 1; i < block.length; i += 1) {
      if (/^      \S/.test(block[i])) break;
      const required = block[i].match(/^        required: (true|false)\s*$/);
      if (required) requestRequired = required[1] === 'true';
      const schema = block[i].match(
        /\$ref: "#\/components\/schemas\/(\w+)"/,
      );
      if (schema && !requestSchema) requestSchema = schema[1];
    }
  }

  const responsesIndex = block.findIndex((line) => /^      responses:/.test(line));
  if (responsesIndex === -1) {
    throw new Error(`${operationId}: missing responses`);
  }
  let successStatus = null;
  let successSchema = null;
  let successContentType = null;
  let stream = false;
  for (let i = responsesIndex + 1; i < block.length; i += 1) {
    const status = block[i].match(/^        "(2\d\d)":/);
    if (!status) continue;
    successStatus = Number(status[1]);
    let end = block.length;
    for (let j = i + 1; j < block.length; j += 1) {
      if (/^        "\d{3}":/.test(block[j])) {
        end = j;
        break;
      }
      if (/^      \S/.test(block[j])) {
        end = j;
        break;
      }
    }
    let inContent = false;
    for (let j = i + 1; j < end; j += 1) {
      if (/^          content:\s*$/.test(block[j])) {
        inContent = true;
        continue;
      }
      if (/^          \S/.test(block[j])) {
        inContent = false;
        continue;
      }
      if (!inContent) continue;
      const contentType = block[j].match(/^            ([\w/+.-]+):\s*$/);
      if (contentType && !successContentType) {
        successContentType = contentType[1];
      }
      const schema = block[j].match(
        /\$ref: "#\/components\/schemas\/(\w+)"/,
      );
      if (schema && !successSchema) successSchema = schema[1];
    }
    if (successContentType === 'text/event-stream') stream = true;
    break;
  }
  if (successStatus === null) {
    throw new Error(`${operationId}: no 2xx response`);
  }

  const csrf = parameters.find((param) => param.component === 'CsrfToken');
  const publicParams = parameters.filter((param) => param.component !== 'CsrfToken');
  const pathParams = [...openapiPath.matchAll(/{(\w+)}/g)].map((match) => match[1]);
  const declaredPathParams = publicParams
    .filter((param) => param.in === 'path')
    .map((param) => param.name);
  if (
    pathParams.length !== declaredPathParams.length ||
    pathParams.some((name) => !declaredPathParams.includes(name))
  ) {
    throw new Error(
      `${operationId}: path placeholders [${pathParams}] do not match path parameters [${declaredPathParams}]`,
    );
  }

  for (const param of publicParams) {
    if (!['path', 'query', 'header'].includes(param.in)) {
      throw new Error(`${operationId}: unsupported parameter location ${param.in}`);
    }
  }

  if (requestSchema && !schemaNames.has(requestSchema)) {
    throw new Error(`${operationId}: unknown request schema ${requestSchema}`);
  }
  if (successSchema && !schemaNames.has(successSchema)) {
    throw new Error(`${operationId}: unknown response schema ${successSchema}`);
  }

  return {
    method: method.toUpperCase(),
    path: openapiPath,
    operationId,
    summary,
    pathParams,
    queryParams: publicParams.filter((param) => param.in === 'query').map((param) => param.name),
    headerParams: publicParams.filter((param) => param.in === 'header').map((param) => param.name),
    requiresCsrf: Boolean(csrf),
    requestSchema,
    requestRequired,
    successStatus,
    successSchema,
    successContentType,
    stream,
    hasBody: requestSchema !== null,
  };
}

export function parseOperations(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const pathsStart = lines.findIndex((line) => /^paths:\s*$/.test(line));
  const componentsStart = lines.findIndex((line) => /^components:\s*$/.test(line));
  if (pathsStart === -1 || componentsStart === -1 || componentsStart < pathsStart) {
    throw new Error('spec must contain paths: before components:');
  }

  const componentParams = parseComponentParameters(lines, componentsStart);
  const schemaNames = parseSchemaNames(lines, componentsStart);
  const operations = [];
  let currentPath = null;

  for (let i = pathsStart + 1; i < componentsStart; i += 1) {
    const pathMatch = lines[i].match(/^  (\/[^:]+):\s*$/);
    if (pathMatch) {
      currentPath = pathMatch[1];
      continue;
    }
    const methodMatch = lines[i].match(/^    (get|post|put|patch|delete):\s*$/);
    if (!methodMatch || !currentPath) continue;
    if (!HTTP_METHODS.has(methodMatch[1])) continue;

    let end = componentsStart;
    for (let j = i + 1; j < componentsStart; j += 1) {
      if (/^  \//.test(lines[j]) || /^    (get|post|put|patch|delete):\s*$/.test(lines[j])) {
        end = j;
        break;
      }
    }
    const block = lines.slice(i, end);
    operations.push(
      parseOperation(
        { method: methodMatch[1], openapiPath: currentPath, block },
        componentParams,
        schemaNames,
      ),
    );
    i = end - 1;
  }

  if (operations.length === 0) throw new Error('no operations found');
  const ids = new Set();
  for (const operation of operations) {
    if (ids.has(operation.operationId)) {
      throw new Error(`duplicate operationId ${operation.operationId}`);
    }
    ids.add(operation.operationId);
  }
  return operations;
}

function primitiveFor(param) {
  return param === 'versionNo' || param === 'limit' ? 'number' : 'string';
}

function jsdocFor(operation) {
  const lines = ['  /**'];
  if (operation.summary) lines.push(`   * ${operation.summary.replace(/\*\//g, '*\\/')}`);
  const params = [];
  if (operation.pathParams.length > 0) {
    const fields = operation.pathParams
      .map((name) => `${JSON.stringify(name)}: ${primitiveFor(name)}`)
      .join(', ');
    params.push(`path: { ${fields} }`);
  }
  if (operation.queryParams.length > 0) {
    const fields = operation.queryParams
      .map((name) => `${JSON.stringify(name)}?: ${primitiveFor(name)}`)
      .join(', ');
    params.push(`query?: { ${fields} }`);
  }
  if (operation.headerParams.length > 0) {
    const fields = operation.headerParams
      .map((name) => `${JSON.stringify(name)}?: string`)
      .join(', ');
    params.push(`headers?: { ${fields} }`);
  }
  const bodyType = `import('./r0a-api-types').components['schemas'][${JSON.stringify(
    operation.requestSchema ?? 'never',
  )}]`;
  if (operation.hasBody) {
    params.push(`body${operation.requestRequired ? '' : '?'}: ${bodyType}`);
  }
  params.push('signal?: AbortSignal');
  const required = operation.hasBody || operation.pathParams.length > 0;
  lines.push(`   * @param {{ ${params.join(', ')} }} ${required ? 'params' : '[params]'}`);
  if (operation.stream) {
    lines.push(
      '   * @returns {Promise<{ status: number, headers: Record<string, string>, events: AsyncGenerator<SseEvent> }>}',
    );
  } else {
    const responseType = operation.successSchema
      ? `import('./r0a-api-types').components['schemas'][${JSON.stringify(operation.successSchema)}]`
      : operation.successContentType?.startsWith('text/')
        ? 'string'
        : 'unknown';
    lines.push(`   * @returns {Promise<WorkResponse<${responseType}>>}`);
  }
  lines.push('   */');
  return lines.join('\n');
}

function renderMethod(operation) {
  return `${jsdocFor(operation)}
  async ${operation.operationId}(params = {}) {
    return request(${JSON.stringify(operation.operationId)}, params);
  }`;
}

export function renderClient(yamlText, operations) {
  const hash = crypto.createHash('sha256').update(yamlText).digest('hex');
  const serializedOperations = JSON.stringify(operations, null, 2)
    .split('\n')
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join('\n');

  return `/**
 * AUTO-GENERATED by generate-client.mjs from r0a-openapi-v1.yaml.
 * Source SHA-256: ${hash}
 *
 * Do not edit by hand. Run: node generate-client.mjs
 * CI runs: node scripts/ci-contract.mjs (fails on drift).
 */

/**
 * @template T
 * @typedef {{ status: number, headers: Record<string, string>, requestId: string | null, data: T }} WorkResponse
 */

/**
 * @typedef {{ id: string | null, event: string | null, data: unknown, rawData: string }} SseEvent
 */

/**
 * @typedef {{
 *   baseUrl?: string,
 *   fetchImpl?: typeof fetch,
 *   credentials?: RequestCredentials,
 *   cookie?: string | null,
 *   csrfToken?: string | null,
 *   getCsrfToken?: (() => string | null | undefined | Promise<string | null | undefined>) | null,
 *   refreshCsrfToken?: (() => string | null | undefined | Promise<string | null | undefined>) | null,
 *   headers?: Record<string, string>,
 * }} WorkClientConfig
 */

/**
 * @typedef {{
 *   method: string,
 *   path: string,
 *   operationId: string,
 *   summary: string,
 *   pathParams: string[],
 *   queryParams: string[],
 *   headerParams: string[],
 *   requiresCsrf: boolean,
 *   requestSchema: string | null,
 *   requestRequired: boolean,
 *   successStatus: number,
 *   successSchema: string | null,
 *   successContentType: string | null,
 *   stream: boolean,
 *   hasBody: boolean,
 * }} WorkOperation
 */

/** @type {ReadonlyArray<WorkOperation>} */
export const OPERATIONS = Object.freeze(${serializedOperations});

export class WorkApiError extends Error {
  /**
   * @param {{ status: number, code: string, message: string, requestId?: string | null, data?: unknown }} details
   */
  constructor({ status, code, message, requestId = null, data = null }) {
    super(message || \`HTTP \${status}\`);
    this.name = 'WorkApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.data = data;
  }
}

/**
 * Parses an SSE byte stream. Frames are separated by a blank line; comment
 * frames (": keep-alive") are ignored. \`data\` is JSON-parsed when possible.
 *
 * @param {ReadableStream<Uint8Array> | null} body
 * @returns {AsyncGenerator<SseEvent>}
 */
export async function* readSse(body) {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\\r\\n/g, '\\n');
      let boundary = buffer.indexOf('\\n\\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseFrame(frame);
        if (event) yield event;
        boundary = buffer.indexOf('\\n\\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const event = parseSseFrame(buffer);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

/** @param {string} frame */
function parseSseFrame(frame) {
  const event = { id: null, event: null, data: null, rawData: '' };
  const dataLines = [];
  let sawField = false;
  for (const line of frame.split('\\n')) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    sawField = true;
    if (field === 'id') event.id = value;
    else if (field === 'event') event.event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (!sawField) return null;
  event.rawData = dataLines.join('\\n');
  if (event.rawData) {
    try {
      event.data = JSON.parse(event.rawData);
    } catch {
      event.data = event.rawData;
    }
  }
  return event;
}

/**
 * Creates a cookie-session client. In a browser, pass \`getCsrfToken\` from the
 * bootstrap response and leave \`cookie\` unset (\`credentials\` carries it).
 * In tests, pass \`cookie\` explicitly.
 *
 * @param {WorkClientConfig} config
 */
export function createWorkClient(config = {}) {
  const {
    baseUrl = '',
    fetchImpl = globalThis.fetch,
    credentials = 'same-origin',
    cookie = null,
    csrfToken = null,
    getCsrfToken = null,
    refreshCsrfToken = null,
    headers: defaultHeaders = {},
  } = config;
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl is required');
  }
  const base = String(baseUrl).replace(/\\/+$/, '');
  let token = csrfToken;
  /** @type {string | null} */
  let refreshedToken = null;

  async function resolveCsrf() {
    if (refreshedToken) return refreshedToken;
    if (typeof getCsrfToken === 'function') {
      const value = await getCsrfToken();
      if (value) return value;
    }
    return token;
  }

  /**
   * @param {string} operationId
   * @param {any} [params]
   * @param {boolean} [csrfRetried]
   */
  async function request(operationId, params = {}, csrfRetried = false) {
    const operation = OPERATIONS.find((entry) => entry.operationId === operationId);
    if (!operation) throw new TypeError(\`unknown operation \${operationId}\`);
    const pathParams = params.path ?? {};
    const queryParams = params.query ?? {};

    let urlPath = operation.path;
    for (const name of operation.pathParams) {
      const value = pathParams[name];
      if (value === undefined || value === null || value === '') {
        throw new TypeError(\`\${operationId}: missing path parameter \${name}\`);
      }
      urlPath = urlPath.replace(\`{\${name}}\`, encodeURIComponent(String(value)));
    }

    const search = new URLSearchParams();
    for (const name of operation.queryParams) {
      const value = queryParams[name];
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        for (const item of value) search.append(name, String(item));
      } else {
        search.append(name, String(value));
      }
    }
    const query = search.toString();
    const url = \`\${base}\${urlPath}\${query ? \`?\${query}\` : ''}\`;

    /** @type {Record<string, string>} */
    const headers = { Accept: 'application/json', ...defaultHeaders, ...(params.headers ?? {}) };
    if (cookie) headers.Cookie = cookie;
    if (operation.stream) headers.Accept = 'text/event-stream';

    let body;
    if (operation.hasBody) {
      if (params.body === undefined && operation.requestRequired) {
        throw new TypeError(\`\${operationId}: request body is required\`);
      }
      if (params.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(params.body);
      }
    }

    if (operation.requiresCsrf && operation.method !== 'GET' && operation.method !== 'HEAD') {
      const csrf = await resolveCsrf();
      if (!csrf) {
        throw new TypeError(
          \`\${operationId}: CSRF token is required; pass getCsrfToken() or csrfToken\`,
        );
      }
      headers['X-CSRF-Token'] = csrf;
    }

    const response = await fetchImpl(url, {
      method: operation.method,
      headers,
      body,
      credentials,
      signal: params.signal,
    });
    const responseHeaders = Object.fromEntries(response.headers.entries());

    if (operation.stream) {
      if (!response.ok) {
        const data = await parseBody(response);
        throw new WorkApiError({
          status: response.status,
          code: data?.code ?? 'http_error',
          message: data?.message ?? \`HTTP \${response.status}\`,
          requestId: responseHeaders['x-request-id'] ?? null,
          data,
        });
      }
      return {
        status: response.status,
        headers: responseHeaders,
        events: readSse(response.body),
      };
    }

    const data = await parseBody(response);
    const requestId =
      responseHeaders['x-request-id'] ??
      (data && (data.request_id ?? data.correlation_id)) ??
      null;
    if (!response.ok) {
      // The server rejects a stale CSRF token before any side effect, so one
      // refresh-and-retry is safe; a second failure surfaces to the caller.
      if (
        response.status === 403 &&
        data?.code === 'csrf_invalid' &&
        operation.requiresCsrf &&
        !csrfRetried &&
        typeof refreshCsrfToken === 'function'
      ) {
        const fresh = await refreshCsrfToken();
        if (fresh) {
          refreshedToken = fresh;
          return request(operationId, params, true);
        }
      }
      throw new WorkApiError({
        status: response.status,
        code: (data && data.code) || 'http_error',
        message: (data && data.message) || \`HTTP \${response.status}\`,
        requestId,
        data,
      });
    }
    return { status: response.status, headers: responseHeaders, requestId, data };
  }

  return {
${operations.map(renderMethod).join(',\n\n')}
  };
}

/** @param {Response} response */
async function parseBody(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}
`;
}

function main() {
  const yamlText = fs.readFileSync(SPEC_PATH, 'utf8');
  const operations = parseOperations(yamlText);
  const rendered = renderClient(yamlText, operations);
  const check = process.argv.includes('--check');

  if (check) {
    const current = fs.existsSync(CLIENT_PATH)
      ? fs.readFileSync(CLIENT_PATH, 'utf8')
      : '';
    if (current !== rendered) {
      console.error(
        `r0a-client.mjs is out of date (${operations.length} operations). Run: node generate-client.mjs`,
      );
      process.exit(1);
    }
    console.log(`r0a-client.mjs up to date (${operations.length} operations)`);
    return;
  }

  fs.writeFileSync(CLIENT_PATH, rendered, 'utf8');
  console.log(`wrote r0a-client.mjs (${operations.length} operations)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
