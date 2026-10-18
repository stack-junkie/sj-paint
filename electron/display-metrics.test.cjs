const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDisplayMetrics } = require('./display-metrics.cjs');

function fixture() {
  const calls = [];
  const owner = createDisplayMetrics({ platform: 'win32', systemRoot: 'C:\\Windows', run(command, args, options, complete) {
    const child = new EventEmitter();
    const call = { command, args, options, complete(error, stdout) { complete(error, stdout); child.emit('close'); }, callback: complete, child, kills: 0 };
    calls.push(call);
    child.kill = () => { call.kills++; return false; };
    return child;
  } });
  return { owner, calls };
}

test('Windows query is fixed, hidden and bounded; concurrent consumers share its owned child', async () => {
  const { owner, calls } = fixture();
  const first = owner.load(), second = owner.load();
  assert.equal(first, second); assert.equal(calls.length, 1); assert.equal(owner.active, true);
  assert.equal(calls[0].options.windowsHide, true); assert.equal(calls[0].options.timeout, 15000); assert.equal(calls[0].options.maxBuffer, 4096);
  calls[0].complete(null, '\uFEFF{"width":2560,"height":1600}');
  assert.deepEqual(await first, { width: 2560, height: 1600, source: 'windows-primary-pixels' });
  assert.equal(owner.active, false);
  const refreshed = owner.load(); assert.equal(calls.length, 2);
  calls[1].complete(null, '{"width":1920,"height":1080}');
  assert.equal((await refreshed).width, 1920);
});

test('failed kill retains the owner and cancellation waits for actual completion', async () => {
  const { owner, calls } = fixture();
  const result = owner.load(); const rejected = assert.rejects(result, /query failed or timed out/);
  let completed = false; const cancellation = owner.cancel().then(() => { completed = true; });
  await Promise.resolve(); assert.equal(completed, false); assert.equal(owner.active, true);
  assert.equal(owner.load(), result); assert.equal(calls[0].kills, 1);
  calls[0].complete(Object.assign(new Error('killed'), { killed: true }), '');
  await rejected; await cancellation; assert.equal(owner.active, false);
});

test('malformed dimensions fail closed and a later request can recover', async () => {
  for (const stdout of ['not json', '{"width":0,"height":100}', '{"width":2560.5,"height":1600}', '{"width":2147483648,"height":100}']) {
    const { owner, calls } = fixture(); const result = owner.load();
    calls[0].complete(null, stdout); await assert.rejects(result, /could not be read/); assert.equal(owner.active, false);
    const next = owner.load(); calls[1].complete(null, '{"width":800,"height":600}'); assert.equal((await next).height, 600);
  }
});

test('kill error callback does not release display ownership before close; late close permits retry', async () => {
  const { owner, calls } = fixture();
  const result = owner.load(); const rejected = assert.rejects(result, /query failed/);
  calls[0].child.kill = () => {
    const error = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    calls[0].child.emit('error', error); return false;
  };
  // Real execFile's error handler invokes its callback before ChildProcess.close.
  calls[0].child.on('error', error => calls[0].callback(error, ''));
  let closed = false; const cancel = owner.cancel().then(() => { closed = true; });
  await rejected;
  assert.equal(owner.active, true); assert.equal(closed, false);
  await assert.rejects(owner.load(), /query failed/); assert.equal(calls.length, 1);
  calls[0].child.emit('close'); await cancel; assert.equal(owner.active, false);
  const next = owner.load(); calls[1].complete(null, '{"width":2560,"height":1600}');
  assert.equal((await next).width, 2560);
});

test('Linux uses its primary display boundary and rejects unknown scale', async () => {
  const owner = createDisplayMetrics({ platform: 'linux', getPrimaryDisplay: () => ({ size: { width: 1600, height: 900 }, scaleFactor: 1.5 }) });
  assert.deepEqual(await owner.load(), { width: 2400, height: 1350, source: 'electron-primary-display' });
  await assert.rejects(createDisplayMetrics({ platform: 'linux', getPrimaryDisplay: () => ({ scaleFactor: NaN }) }).load(), /scale could not be read/);
});

test('actual Windows helper returns integer primary pixels and closes', { skip: process.platform !== 'win32' || process.env.SJ_PAINT_TEST_DISPLAY_METRICS !== '1' }, async () => {
  const owner = createDisplayMetrics();
  try { const metrics = await owner.load(); assert.equal(metrics.source, 'windows-primary-pixels'); assert.ok(metrics.width > 0 && metrics.height > 0); assert.equal(owner.active, false); }
  finally { await owner.cancel(); }
});
