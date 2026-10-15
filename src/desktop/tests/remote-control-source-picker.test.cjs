const assert = require('node:assert/strict');
const { test } = require('node:test');
const { chooseCaptureSource } = require('../dist/remote-control/source-picker.js');

test('all 27 ordinary windows remain selectable by stable ID across native pages', async () => {
  const sources = Array.from({ length: 27 }, (_, i) => ({ id: `window:${i}:0`, display_id: '', name: 'Same title' }));
  const visited = [];
  const selected = await chooseCaptureSource({ sources, displays: [], fullScreenOnly: false, isCurrent: () => true,
    ask: async options => { visited.push(options); return { response: visited.length < 5 ? options.buttons.indexOf('下一页') : 3 }; } });
  assert.equal(selected.id, 'window:26:0'); assert.equal(visited.length, 5);
  assert.match(visited[0].detail, /共 27 项/); assert.match(visited[4].detail, /第 5 \/ 5 页/);
  assert.ok(visited.every(options => options.buttons.length <= 9 && options.defaultId === 0 && options.cancelId === 0));
});

test('full-screen intent excludes windows and labels distinguish identical monitor names and negative positions', async () => {
  const sources = [{ id: 'window:1:0', display_id: '', name: 'Entire Screen' }, { id: 'screen:7:0', display_id: '7', name: 'Screen' }, { id: 'screen:8:0', display_id: '8', name: 'Screen' }];
  const displays = [7, 8].map((id, i) => ({ id, label: 'Monitor', bounds: { x: -2560 * i, y: 0, width: 2560, height: 1440 }, scaleFactor: 1.5 }));
  const selected = await chooseCaptureSource({ sources, displays, fullScreenOnly: true, isCurrent: () => true,
    ask: async options => { assert.match(options.detail, /屏幕 7/); assert.match(options.detail, /屏幕 8/); assert.match(options.detail, /-2560/); assert.doesNotMatch(options.detail, /Entire Screen/); return { response: 2 }; } });
  assert.equal(selected.id, 'screen:8:0');
});

test('cancel, duplicate source IDs and a context revoked during a page cannot choose a source', async () => {
  const source = { id: 'screen:1:0', display_id: '1', name: 'Screen' };
  let current = true, calls = 0;
  const options = { sources: [source], displays: [], fullScreenOnly: true, isCurrent: () => current,
    ask: async () => { calls++; current = false; return { response: 1 }; } };
  assert.equal(await chooseCaptureSource(options), undefined); assert.equal(calls, 1);
  current = true; assert.equal(await chooseCaptureSource({ ...options, sources: [source, source] }), undefined); assert.equal(calls, 1);
  assert.equal(await chooseCaptureSource({ ...options, ask: async () => ({ response: 0 }) }), undefined);
  for (const response of [-1, 99, 1.5])
    assert.equal(await chooseCaptureSource({ ...options, ask: async () => ({ response }) }), undefined);
});
