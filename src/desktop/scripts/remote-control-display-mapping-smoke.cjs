// Actual Electron conversions in an isolated process; no windows, pixels or input.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

async function main() {
  const project = path.resolve(__dirname, '..');
  await fs.mkdir(path.join(project, 'test-results'), { recursive: true });
  const output = await fs.mkdtemp(path.join(project, 'test-results/display-mapping-'));
  const worker = path.join(output, 'probe.cjs');
  await fs.writeFile(worker, `
const { app, screen } = require('electron');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { bindScreenSource } = require(${JSON.stringify(path.join(project, 'dist/remote-control/source-binding.js'))});
app.setPath('userData', ${JSON.stringify(path.join(output, 'profile'))});
app.whenReady().then(() => {
  const physical = {x:0,y:0,width:3072,height:1920};
  const dip = screen.screenToDipRect(null, physical);
  const roundTrip = screen.dipToScreenRect(null, dip);
  const report = {electron:process.versions.electron,physical,dip,roundTrip,passed:false};
  try {
    assert.equal(screen.getPrimaryDisplay().scaleFactor, 1.75);
    assert.deepEqual(dip, {x:0,y:0,width:1756,height:1098});
    assert.deepEqual(roundTrip, {x:0,y:0,width:3073,height:1922});
    const native = {left:0,top:0,width:3072,height:1920,rotation:0,dpiX:168,dpiY:168,deviceName:'fixture',devicePath:'fixture-only'};
    const binding = bindScreenSource({id:'screen:1:0',display_id:'1'},
      [{id:1,bounds:dip,scaleFactor:1.75,rotation:0}], [native],
      {toDip:rect => screen.screenToDipRect(null,rect)});
    assert.equal(binding.native.width,3072);
    assert.equal(binding.native.height,1920);
    report.passed = true;
  } catch(error) { report.error = error.message; }
  fs.writeFileSync(${JSON.stringify(path.join(output, 'report.json'))}, JSON.stringify(report,null,2));
  app.exit(report.passed ? 0 : 1);
}).catch(error => { console.error(error); app.exit(1); });
`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let failure;
  try {
    await promisify(execFile)(require('electron'), [worker, '--force-device-scale-factor=1.75', '--no-default-protocol-registration'],
      { env, windowsHide: true, timeout: 20000, maxBuffer: 65536 });
  } catch(error) { failure = error; }
  const report = JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8'));
  console.log(JSON.stringify({ ...report, output }));
  assert.equal(report.passed, true, report.error || failure?.message);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
