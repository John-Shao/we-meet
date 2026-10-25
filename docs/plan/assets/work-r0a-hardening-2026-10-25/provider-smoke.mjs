/**
 * Real-provider smoke for the D4 egress boundary.
 *
 * The key comes only from DASHSCOPE_API_KEY in the process environment. The
 * output contains metadata/hash only; prompt and response text are never
 * printed. This does not prove vendor terms, residency, training/retention or
 * price ceilings.
 */
import { createHash, randomUUID } from 'node:crypto';

const key = process.env.DASHSCOPE_API_KEY;
const endpoint =
  process.env.DASHSCOPE_ENDPOINT ??
  'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
const model = process.env.DASHSCOPE_MODEL ?? 'qwen3.8-flash';
const prompt = '用一句话说明什么是可验收的 AI 工作成果。不要输出任何密钥或个人信息。';
const operationId = randomUUID();
const fence = 3;
const requestHash = `sha256:${createHash('sha256')
  .update(JSON.stringify({ model, prompt, source: 'user_input' }))
  .digest('hex')}`;

if (!key) {
  console.log(JSON.stringify({ ok: false, error: 'provider_key_missing' }));
  process.exit(2);
}

const started = Date.now();
let firstTokenAt = null;
let content = '';
let usage = null;
let providerRequestId = null;
let status = 0;

try {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 64,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(30000),
  });
  status = response.status;
  providerRequestId = response.headers.get('x-request-id');
  if (!response.ok) {
    console.log(
      JSON.stringify({
        ok: false,
        status,
        error: 'provider_http_error',
        request_hash: requestHash,
        operation_id: operationId,
        fence,
        provider_request_id: providerRequestId,
      }),
    );
    process.exit(1);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        const json = JSON.parse(data);
        if (json.id) providerRequestId ??= json.id;
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          if (firstTokenAt === null) firstTokenAt = Date.now() - started;
          content += delta;
        }
        if (json.usage) usage = json.usage;
      }
    }
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  console.log(
    JSON.stringify({
      ok: true,
      status,
      model,
      latency_ms: Date.now() - started,
      first_token_ms: firstTokenAt,
      bytes,
      content_hash: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      usage,
      provider_request_id: providerRequestId,
      request_hash: requestHash,
      source_label: 'user_input',
      operation_id: operationId,
      fence,
      no_content_logged: true,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      status,
      error: error.name,
      message: error.message,
      request_hash: requestHash,
      operation_id: operationId,
      fence,
      provider_request_id: providerRequestId,
    }),
  );
  process.exit(1);
}
