const test = require('node:test');
const assert = require('node:assert/strict');
const { createQuitCoordinator } = require('./quit-coordinator.cjs');
const settle = () => new Promise(resolve => setImmediate(resolve));
const failure = { ok: false, error: { code: 'CLEANUP', message: 'Owned child has not closed.' } };
function fixture(shutdown) {
  const scheduled = [], failures = [];
  let quits = 0, prevented = 0;
  const coordinator = createQuitCoordinator({ shutdown, requestQuit: () => { quits++; }, reportFailure: value => failures.push(value), schedule: callback => scheduled.push(callback) });
  return { coordinator, failures, scheduled, request: () => coordinator.willQuit({ preventDefault() { prevented++; } }),
    flush: () => { const callbacks = scheduled.splice(0); callbacks.forEach(callback => callback()); },
    state: () => ({ quits, prevented }) };
}

test('successful cleanup resumes quit on a later event-loop turn, exactly once', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return { ok: true }; });
  f.request(); f.request(); await settle();
  assert.equal(calls, 1); assert.equal(f.state().quits, 0);
  assert.equal(f.scheduled.length, 1);
  f.coordinator.ownershipReleased(); f.flush(); f.request();
  assert.equal(f.state().quits, 1); assert.equal(f.state().prevented, 2);
  assert.equal(f.scheduled.length, 0);
});

for (const timing of ['before failure settles', 'after failure settles']) test(`confirmed late release ${timing} resumes only after successful cleanup`, async () => {
  let finish, calls = 0, ownsProcess = true;
  const f = fixture(() => {
    calls++;
    return calls === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(ownsProcess ? failure : { ok: true });
  });
  f.request(); await settle();
  if (timing === 'before failure settles') { ownsProcess = false; f.coordinator.ownershipReleased(); }
  finish(failure); await settle();
  assert.equal(f.state().quits, 0); assert.deepEqual(f.failures, [failure]);
  if (timing === 'after failure settles') { assert.equal(f.scheduled.length, 0); ownsProcess = false; f.coordinator.ownershipReleased(); }
  f.coordinator.ownershipReleased(); // Multiple owners may close in the same turn.
  assert.equal(f.scheduled.length, 1); f.flush(); await settle();
  assert.equal(calls, 2); assert.equal(f.state().quits, 0);
  f.flush(); assert.equal(f.state().quits, 1); assert.deepEqual(f.failures, [failure]);
});

test('unresolved cleanup remains blocked without polling, force exit or a new worker', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return failure; });
  f.request(); await settle(); await settle();
  assert.equal(calls, 1); assert.equal(f.scheduled.length, 0); assert.equal(f.state().quits, 0);
  f.coordinator.ownershipReleased(); f.flush(); await settle();
  assert.equal(calls, 2); assert.equal(f.scheduled.length, 0); assert.equal(f.state().quits, 0);
});

test('release before committed quit does not initiate shutdown or consume a future veto', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return { ok: true }; });
  f.coordinator.ownershipReleased(); await settle();
  assert.equal(calls, 0); assert.equal(f.scheduled.length, 0);
  f.request(); await settle(); f.flush(); assert.equal(f.state().quits, 1);
});

test('closed coordinator ignores late callbacks and pending scheduled work', async () => {
  const f = fixture(async () => ({ ok: true }));
  f.request(); await settle(); f.coordinator.dispose(); f.flush();
  f.coordinator.ownershipReleased(); f.request(); await settle();
  assert.equal(f.state().quits, 0); assert.equal(f.scheduled.length, 0);
});
