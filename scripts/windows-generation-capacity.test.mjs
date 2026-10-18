import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCapacityStream, parseSingleGpuCapacity, pendingCapacityStreams } from './windows-generation-capacity.mjs';

test('optional GPU admission rejects ambiguous devices and malformed capacity',()=>{
  const uuid='GPU-01234567-0123-4567-89ab-0123456789ab',row=uuid+', 2048';
  assert.deepEqual(parseSingleGpuCapacity(row),{gpuUuid:uuid,gpuFreeMiB:2048});
  assert.equal(parseSingleGpuCapacity(row,'0').gpuFreeMiB,2048);
  assert.equal(parseSingleGpuCapacity(row,uuid).gpuUuid,uuid);
  for(const visible of ['','1','0,1','GPU-different'])assert.throws(()=>parseSingleGpuCapacity(row,visible),/same device/);
  assert.throws(()=>parseSingleGpuCapacity(row+'\n'+row),/one NVIDIA GPU/);
  assert.throws(()=>parseSingleGpuCapacity(uuid+', N\/A'),/invalid UUID or memory/);
  assert.throws(()=>parseSingleGpuCapacity(uuid+', '+ '9'.repeat(400)),/invalid UUID or memory/);
});

test('capacity stream handles partial frames, rejects stale data and waits for actual close',async()=>{
  const child=Object.assign(new EventEmitter(),{pid:123,stdout:new EventEmitter(),stderr:new EventEmitter()});
  let clock=100, killed=0;
  child.kill=()=>{killed++;return true;};
  const reader=createCapacityStream('fixture',[],JSON.parse,{spawnProcess:()=>child,now:()=>clock});
  child.stdout.emit('data','{"capacity":');
  assert.throws(()=>reader.read(),/stale/);
  child.stdout.emit('data','42}\n');
  assert.equal((await reader.ready()).capacity,42);
  clock+=5001;assert.throws(()=>reader.read(),/stale/);
  child.stdout.emit('data','{"capacity":43}\n');assert.equal(reader.read().capacity,43);
  let resolved=false;
  const closing=reader.close().then(value=>{resolved=true;return value;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(killed,1);assert.equal(resolved,false);assert.equal(reader.receipt.closedUtc,undefined);
  child.emit('close',null,'SIGTERM');
  assert.ok((await closing).closedUtc);assert.throws(()=>reader.read(),/closed/);
  await reader.close();assert.equal(killed,1);
});

test('malformed and oversized stream data stay failed instead of accepting later samples',async()=>{
  for(const data of ['not-json\n','x'.repeat(10001)]){
    const child=Object.assign(new EventEmitter(),{pid:124,stdout:new EventEmitter(),stderr:new EventEmitter()});
    child.kill=()=>{queueMicrotask(()=>child.emit('close',1,null));return true;};
    const reader=createCapacityStream('fixture',[],JSON.parse,{spawnProcess:()=>child});
    child.stdout.emit('data',data);child.stdout.emit('data','{"capacity":42}\n');
    assert.throws(()=>reader.read());await assert.rejects(reader.ready());await reader.close();
  }
});

test('cleanup timeout retains the owner until confirmed late closure',async()=>{
  const child=Object.assign(new EventEmitter(),{pid:125,stdout:new EventEmitter(),stderr:new EventEmitter(),kill:()=>true});
  const reader=createCapacityStream('fixture',[],JSON.parse,{spawnProcess:()=>child,cleanupTimeoutMs:10});
  await assert.rejects(reader.close(),error=>error.samplerOwner===reader&&error.receipt===reader.receipt);
  assert.ok(pendingCapacityStreams().includes(reader));assert.equal(reader.receipt.closedUtc,undefined);
  child.emit('close',null,'SIGTERM');
  assert.ok((await reader.waitForClose()).closedUtc);
  assert.equal(pendingCapacityStreams().includes(reader),false);
  await reader.close();
});
