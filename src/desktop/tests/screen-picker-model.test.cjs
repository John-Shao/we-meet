const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildPickerEntries } = require('../dist/screen-picker/model.js');

const image = () => ({
  isEmpty: () => false,
  toJPEG: quality => { assert.equal(quality, 78); return Buffer.from('thumb'); },
  toDataURL: () => 'data:image/png;base64,aWNvbg==',
});
const emptyImage = () => ({ isEmpty: () => true, toJPEG: () => Buffer.alloc(0), toDataURL: () => '' });
const tokens = () => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
};

test('screens follow display order with labels, physical resolution and JPEG thumbnails', () => {
  const sources = [
    { id: 'screen:2:0', display_id: '2', name: 'Screen 2', thumbnail: image() },
    { id: 'screen:1:0', display_id: '1', name: 'Screen 1', thumbnail: image() },
    { id: 'screen:9:0', display_id: '9', name: 'Side Screen', thumbnail: emptyImage() },
  ];
  const displays = [
    { id: 1, label: '主屏', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    { id: 2, label: '', bounds: { x: 1920, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5 },
  ];
  const { screens, windows } = buildPickerEntries(sources, displays, { token: tokens() });
  assert.equal(windows.length, 0);
  assert.deepEqual(screens.map(entry => entry.item.title), ['桌面 1', '桌面 2', '桌面 3']);
  assert.equal(screens[0].item.subtitle, '主屏 · 1920 × 1080');
  assert.equal(screens[1].item.subtitle, '1920 × 1080');
  assert.equal(screens[2].item.subtitle, 'Side Screen');
  assert.equal(screens[0].item.thumbnail, 'data:image/jpeg;base64,dGh1bWI=');
  assert.equal(screens[2].item.thumbnail, undefined);
  assert.equal(screens[0].source.id, 'screen:1:0');
});

test('windows keep capture order, drop duplicates and picker itself, and sanitize names', () => {
  const sources = [
    { id: 'window:2:0', display_id: '', name: '  \u0000Editor \u202e ', thumbnail: image(), appIcon: image() },
    { id: 'window:1:0', display_id: '', name: 'Notes', thumbnail: image(), appIcon: emptyImage() },
    { id: 'window:2:0', display_id: '', name: 'Duplicate', thumbnail: image() },
    { id: 'window:9:0', display_id: '', name: '', thumbnail: image() },
    { id: 'window:3:0', display_id: '', name: '选择要共享的屏幕或窗口', thumbnail: image() },
  ];
  const { screens, windows } = buildPickerEntries(sources, [], {
    excludeId: 'window:3:0',
    token: tokens(),
  });
  assert.equal(screens.length, 0);
  assert.deepEqual(windows.map(entry => entry.item.title), ['Editor', 'Notes', '未命名窗口']);
  assert.equal(windows[0].item.icon, 'data:image/png;base64,aWNvbg==');
  assert.equal(windows[1].item.icon, undefined);
  assert.ok(windows.every(entry => !entry.source.id.startsWith('window:3:')));
});

test('tokens are fresh opaque UUIDs, never source IDs or display IDs', () => {
  const sources = [
    { id: 'screen:1:0', display_id: '1', name: 'Screen' },
    { id: 'window:1:0', display_id: '', name: 'Window' },
  ];
  const displays = [{ id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, scaleFactor: 1 }];
  const { screens, windows } = buildPickerEntries(sources, displays);
  const all = [...screens, ...windows];
  assert.equal(new Set(all.map(entry => entry.item.token)).size, 2);
  for (const entry of all) {
    assert.match(entry.item.token, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
    assert.notEqual(entry.item.token, entry.source.id);
  }
});

test('empty and malformed sources never become selectable entries', () => {
  const { screens, windows } = buildPickerEntries(
    [null, {}, { id: '', name: 'blank' }, { id: 'bogus', name: 'other' }],
    [],
  );
  assert.equal(screens.length, 0);
  assert.equal(windows.length, 0);
});
