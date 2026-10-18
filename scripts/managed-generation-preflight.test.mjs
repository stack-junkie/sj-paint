import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyManagedGenerationDesktop } from './verify-managed-generation-desktop.mjs';

// These checks establish only preflight admission. No browser, worker,
// inference, clipboard or native application is created by this test.
for (const [name, capacity, expected] of [
  ['refuses low host commit', { availableCommitBytes: 1024 ** 3, gpuFreeMiB: 2048 }, /Resource reserve/],
  ['refuses invalid host commit', { availableCommitBytes: NaN, gpuFreeMiB: 2048 }, /invalid capacity/],
  ['accepts CPU capacity without GPU observation', { availableCommitBytes: 8 * 1024 ** 3 }, /absolute photo fixture/],
  ['ignores unused GPU observation for CPU erase', { availableCommitBytes: 8 * 1024 ** 3, gpuFreeMiB: NaN }, /absolute photo fixture/],
]) {
  test(`generation ${name} before admitting work`, async () => {
    const temporaryRoot=resolve(tmpdir()), owned=await mkdtemp(join(temporaryRoot,'sj-generation-preflight-'));
    const outputDirectory=join(owned,'evidence');
    let inspectorCalls=0, rendererCalls=0;
    const page={locator:()=>({count:async()=>0}),evaluate:async callback=>{
      rendererCalls++;
      const source=callback.toString();
      if(source.includes('localAiRelease'))return {ok:true,value:{}};
      if(source.includes('localAiStatus'))return {ok:true,value:{active:null,generationSession:null,ownsProcess:false,cleanupBlocked:false}};
      throw new Error('Preflight unexpectedly attempted a renderer action.');
    }};
    const check=(_name,ok)=>assert.equal(ok,true);check.skip=()=>{};
    try {
      await assert.rejects(verifyManagedGenerationDesktop(page,check,async()=>{inspectorCalls++;throw new Error('Preflight reached inspector.');},
        {outputDirectory,sampleCapacity:async()=>capacity}),expected);
      assert.equal(inspectorCalls,0);
      assert.equal(rendererCalls,2,'only final release and status are permitted');
      const report=JSON.parse(await readFile(join(outputDirectory,'report.json'),'utf8'));
      assert.match(report.failure.message,expected);
      assert.deepEqual(report.operations,[]);
      assert.equal(report.final.ok,true);
    }finally{
      assert.equal(dirname(resolve(owned)),temporaryRoot);
      await rm(owned,{recursive:true});
    }
  });
}
