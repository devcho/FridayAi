import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { getOllamaStatus } from '../lib/agent.mjs';

test('Ollama status hides cloud and locally blocked crash-prone models', async t => {
  const ollama = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ models: [
      { name: 'qwen3.5:9b', size: 6550825550, details: { parameter_size: '9.0B' } },
      { name: 'glm-4.7-flash:latest', size: 19019270897, details: { parameter_size: '29.9B' } },
      { name: 'remote:cloud', size: 1 },
    ] }));
  });
  ollama.listen(0, '127.0.0.1');
  await once(ollama, 'listening');
  t.after(() => new Promise(resolve => { ollama.closeAllConnections(); ollama.close(resolve); }));

  const status = await getOllamaStatus(`http://127.0.0.1:${ollama.address().port}`);
  assert.equal(status.connected, true);
  assert.deepEqual(status.models.map(model => model.name), ['qwen3.5:9b']);
});
