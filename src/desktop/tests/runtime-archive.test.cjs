const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('native archive extractor accepts files and rejects traversal, ADS, aliases and links before writing', { skip: process.platform !== 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wemeet-archive-'));
  try {
    const script = path.resolve(__dirname, '../scripts/extract-runtime.ps1');
    const cases = [
      { name: 'valid', entries: ['python/Lib/module.py', 'manifest.json'], accepted: true },
      { name: 'traversal', entries: ['safe.txt', '../escape.txt'] },
      { name: 'ads', entries: ['safe.txt', 'file.txt:stream'] },
      { name: 'alias', entries: ['safe.txt', 'CON.txt'] },
      { name: 'duplicate', entries: ['file.txt', 'FILE.txt'] },
      { name: 'backslash', entries: ['safe.txt', '..\\escape.txt'] },
      { name: 'symlink', entries: ['safe.txt', 'link'], link: true },
    ];
    for (const fixture of cases) {
      const archive = path.join(root, fixture.name + '.zip');
      const destination = path.join(root, fixture.name);
      const created = spawnSync('python', ['-c',
        'import sys,json,zipfile; c=json.loads(sys.argv[2]); z=zipfile.ZipFile(sys.argv[1],"w");\n' +
        'for name in c["entries"]:\n i=zipfile.ZipInfo(name); i.create_system=3; i.external_attr=(0o120777 if c.get("link") and name=="link" else 0o100600)<<16; z.writestr(i,b"fixture")\n' +
        'z.close()', archive, JSON.stringify(fixture)], { encoding: 'utf8', windowsHide: true });
      assert.equal(created.status, 0, created.stderr);
      const extracted = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Archive', archive, '-Destination', destination], { encoding: 'utf8', windowsHide: true });
      if (fixture.accepted) {
        assert.equal(extracted.status, 0, extracted.stderr);
        assert.equal(fs.readFileSync(path.join(destination, 'python/Lib/module.py'), 'utf8'), 'fixture');
      } else {
        assert.notEqual(extracted.status, 0, fixture.name);
        assert.match(extracted.stderr, /runtime_invalid_package/);
        assert.equal(fs.existsSync(destination), false, fixture.name + ' must reject before extraction');
      }
    }
    assert.equal(fs.existsSync(path.join(root, 'escape.txt')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
