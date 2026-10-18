import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { managedAiTestProfile } from './managed-ai-test-profile.mjs';

test('explicit managed-profile admission preserves registry and rejects mismatched or unresolved receipts', async () => {
  const temporaryRoot=resolve(tmpdir()), owned=await mkdtemp(join(temporaryRoot,'sj-profile-admission-'));
  const profilePath=join(owned,'profile'), repository=join(owned,'checkout'), setupReceiptPath=join(owned,'setup.json');
  await mkdir(join(profilePath,'ai'),{recursive:true});
  const features=Object.fromEntries(['u2net','efficientsam-ti'].map(name=>[name,{
    runtimeId:'win32-x64-onnx',runtime:'r/'+'a'.repeat(16),model:'m/'+'b'.repeat(16),manifestDigest:'c'.repeat(64),
  }]));
  const registryPath=join(profilePath,'ai/active.json'), registry=JSON.stringify({features});
  const receipt={status:'ready',userDataPath:profilePath,repository,finalState:{ownsProcess:false,cleanupPending:false}};
  try {
    await writeFile(registryPath,registry);await writeFile(setupReceiptPath,JSON.stringify(receipt));
    const admitted=await managedAiTestProfile(repository,{profilePath,setupReceiptPath});
    assert.equal(admitted.profile,profilePath);
    assert.equal(await readFile(registryPath,'utf8'),registry);
    await assert.rejects(managedAiTestProfile(repository,{profilePath:'relative',setupReceiptPath}),/explicit absolute/);
    await assert.rejects(managedAiTestProfile(join(owned,'other-checkout'),{profilePath,setupReceiptPath}),/does not establish/);
    await writeFile(setupReceiptPath,JSON.stringify({...receipt,finalState:{ownsProcess:true,cleanupPending:true}}));
    await assert.rejects(managedAiTestProfile(repository,{profilePath,setupReceiptPath}),/does not establish/);
  } finally {
    assert.equal(dirname(resolve(owned)),temporaryRoot);
    await rm(owned,{recursive:true});
  }
});
