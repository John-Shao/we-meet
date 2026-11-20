// The bundled deterministic device_local model fixture (execution-face E3乙 dev fixture profile,
// device-design §5.4). A REAL local HTTP process listening ONLY on literal 127.0.0.1, returning
// canned Chat Completions replies so the model→tool→artifact loop is reproducible without a live
// model. It is a genuine process whose listener identity the Broker's §5.4 gate reads (node image,
// current-user SID, unsigned → the dev profile pins the image hash). It never reaches the network
// beyond loopback and never follows a redirect.
//
// argv[2] = port (required). argv[3] = optional scenario JSON file: an array of assistant `message`
// objects returned in request order (the sequential tool loop). With no scenario, the first request
// drives an artifact.write tool call and the second stops — enough for the proxy↔fixture gate proof.
import http from 'node:http';
import fs from 'node:fs';

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) {
  process.stderr.write('fixture-server: a positive port argv[2] is required\n');
  process.exit(2);
}
const scenarioPath = process.argv[3];
const scenario = scenarioPath ? JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) : null;
let counter = 0;

function nextMessage() {
  if (Array.isArray(scenario) && scenario.length > 0) {
    const message = scenario[Math.min(counter, scenario.length - 1)];
    counter += 1;
    return message;
  }
  counter += 1;
  if (counter === 1) {
    return {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'artifact.write', arguments: '{}' },
        },
      ],
    };
  }
  return { role: 'assistant', content: 'Artifact written.' };
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      // The body is the canonical local_model_request doc; the fixture is deterministic and does not
      // need its content, but it must consume it so the connection drains cleanly.
      void body;
      const message = nextMessage();
      const finishReason = message.tool_calls ? 'tool_calls' : 'stop';
      const doc = {
        id: `fixture-${counter}`,
        object: 'chat.completion',
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
      const bytes = Buffer.from(JSON.stringify(doc), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': bytes.length,
        Connection: 'close',
      });
      res.end(bytes);
    });
  } else {
    res.writeHead(404, { Connection: 'close' });
    res.end();
  }
});

// Literal loopback only (§5.4 step 1): never 0.0.0.0, never a hostname.
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`fixture listening ${port}\n`);
});