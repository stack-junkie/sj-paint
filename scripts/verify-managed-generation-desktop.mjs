import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Actual public controls, preload, controller and workers. The observer delegates
// each IPC request unchanged and retains its input/output, never substituting AI
// responses. Native chooser responses still come from the caller's fixture.
// CPU erase requires host commit capacity, not guest free RAM; GPU sampling is optional.
export async function verifyManagedGenerationDesktop(page, check, main, { outputDirectory, sampleCapacity, verifyIsolatedCopy, photoFixture, scope = 'all' }) {
  if (scope !== 'all') throw new Error('Generation verification scope must be all.');
  if (!isAbsolute(outputDirectory) || typeof sampleCapacity !== 'function') throw new Error('Explicit output directory and resource sampler are required.');
  const photoDigest = 'c85038b3d12b345c37c4ec681473c00e762e526c4b263c62747457c67d68cded';
  await mkdir(outputDirectory); // A fresh directory is mandatory; never replace evidence.
  const report = { startedUtc: new Date().toISOString(), outputDirectory, scope,
    boundary: 'Actual packaged public generation. Chooser responses are controlled. Quality requires review of retained images.',
    quality: { status: 'pending visual review', questions: ['Photo erase matches its surroundings without a visible seam or retained shuttle?'] },
    photoFixture: { path: photoFixture, sha256: photoDigest, provenance: 'NASA astronaut photograph, public domain; existing evaluator 1024 pixel derivative.', polygon: [[720,0],[970,0],[984,598],[716,598],[690,492],[700,296]] },
    plannedOperations: { completedGenerations: 1, earlyCancellation: 1, modes: ['erase'] },
    limits: { minimumAvailableCommitBytes: 1.5 * 1024 ** 3, sampleIntervalMs: 500, operationTimeoutMs: 15 * 60_000 },
    samples: [], files: [], operations: [] };
  const saveReport = () => writeFile(join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2));
  const retain = async (name, bytes) => {
    await writeFile(join(outputDirectory, name), bytes, { flag: 'wx' });
    report.files.push({ name, bytes: bytes.length, sha256: sha256(bytes) });
  };
  const retainPng = (name, png) => retain(name, Buffer.from(png.split(',')[1], 'base64'));
  const status = () => page.evaluate(() => window.paintDesktop.localAiStatus());
  const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const key = async value => { await page.locator('#overlay').focus(); await page.keyboard.press(value); await frame(); };
  const pixels = () => page.locator('#canvas').evaluate(canvas => canvas.toDataURL());
  const dialog = page.locator('.generation-dialog');
  let observed = false, watcher, inFlight = null, guardFailure = null, activeStarted = 0, lastOperation;
  const sample = async () => {
    const capacity = await sampleCapacity();
    if (!Number.isFinite(capacity.availableCommitBytes) || capacity.availableCommitBytes < 0) throw new Error('Resource monitor returned invalid capacity.');
    const record = { utc: new Date().toISOString(), ...capacity }; report.samples.push(record);
    if (capacity.availableCommitBytes < report.limits.minimumAvailableCommitBytes) throw new Error('Resource reserve reached; generation canceled to preserve other applications.');
    return record;
  };
  const cancelOwnedRequest = async reason => {
    if (guardFailure) return;
    guardFailure = reason;
    const active = await main('globalThis.__sjGenerationObservation?.active');
    report.guardCancellation = { utc: new Date().toISOString(), reason, id: active ?? null };
    if (active) report.guardCancellation.result = await page.evaluate(id => window.paintDesktop.localAiCancel({ id }), active);
    await saveReport();
  };
  // Decode copies only; reading live canvas pixels changes Chromium's rendering
  // backend on this host and can invalidate exact preview/commit comparisons.
  const compare = (before, after, region = null, mask = null) => page.evaluate(async ({ before, after, region, mask }) => {
    const decode = async png => {
      const image = new Image(); image.src = png; await image.decode();
      const canvas = Object.assign(document.createElement('canvas'), { width: image.width, height: image.height });
      const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0);
      return { width: canvas.width, height: canvas.height, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
    };
    const a = await decode(before), b = await decode(after), owned = mask ? await decode(mask) : null;
    if (owned && (owned.width !== a.width || owned.height !== a.height)) throw new Error('Submitted mask dimensions differ from source.');
    if (a.width !== b.width || a.height !== b.height) return { equal: false, dimensions: [a.width, a.height, b.width, b.height] };
    let changed = 0, outsideChanged = 0, transparent = 0, opaque = 0, partial = 0;
    for (let p = 0; p < a.width * a.height; p++) {
      const x = p % a.width, y = Math.floor(p / a.width), i = p * 4;
      if (b.data[i + 3] === 0) transparent++; else if (b.data[i + 3] === 255) opaque++; else partial++;
      if (a.data.slice(i, i + 4).some((v, c) => v !== b.data[i + c])) {
        changed++;
        if (owned ? owned.data[i] === 0 : region && (x < region.x || y < region.y || x >= region.x + region.width || y >= region.y + region.height)) outsideChanged++;
      }
    }
    return { equal: changed === 0, changed, outsideChanged, transparent, opaque, partial, width: a.width, height: a.height };
  }, { before, after, region, mask });
  const setDestination = name => main(`__sjPaintVerification.file = ${JSON.stringify(join(outputDirectory, name))}`);
  const openGeneration = async (command, prompt) => {
    await page.locator('[data-menu="ai"]').click(); await page.locator(`[data-command="${command}"]`).click();
    await dialog.waitFor();
    if (command === 'generative-erase') {
      if (!await dialog.locator('[name="prompt"]').isHidden()) throw new Error('Erase must not offer a prompt that its removal model cannot consume.');
    } else await dialog.locator('[name="prompt"]').fill(prompt);
  };
  const generate = async (mode, { candidate = 1, label = mode } = {}) => {
    if(guardFailure)throw new Error(guardFailure);
    await sample(); activeStarted = Date.now();
    await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
    // The operation either produces a candidate or reports its real failure.
    await page.waitForFunction(() => {
      const panel = document.querySelector('.generation-dialog');
      return panel && !panel.querySelector('[type="submit"]').disabled;
    }, null, { timeout: report.limits.operationTimeoutMs + 15_000 });
    activeStarted = 0;
    if (guardFailure) throw new Error(guardFailure);
    // The creativity <output> also has an implicit status role. Read the
    // operation's explicit live status, not the separate numeric control value.
    const text = await dialog.locator('p[role="status"]').textContent();
    if (!await dialog.locator('.generation-preview canvas').count()) throw new Error(`${mode} produced no candidate: ${text}`);
    const operation = await main('globalThis.__sjGenerationObservation.operations.at(-1)'); lastOperation = operation;
    report.operations.push(operation);
    check(`${mode} uses the actual production 1024 request and matching response`, operation.request.mode === mode &&
      (mode === 'erase' || operation.request.steps === 30) && operation.request.width === 1024 && operation.request.height === 1024 && operation.result?.ok &&
      operation.result.value.targetToken === operation.request.targetToken, operation);
    const model = report.initial.value.generation.models[mode];
    const identity = report.initial.value.generation.modelDetails[model], metadata = operation.result.value.metadata;
    check('Erase confirms the pinned CPU removal model and exact selection ownership path', model === 'migan' &&
      metadata?.model === model && metadata.provider === 'CPUExecutionProvider' && metadata.modelSha256 === identity.sha256 &&
      metadata.conditioningMargin === 3 && !Object.hasOwn(metadata, 'requestedStrength') && !Object.hasOwn(metadata, 'effectiveStrength') &&
      operation.request.prompt === '', metadata);
    for (const name of operation.files) {
      const bytes = await readFile(join(outputDirectory, name)); report.files.push({ name, bytes: bytes.length, sha256: sha256(bytes) });
    }
    await dialog.getByRole('button', { name: `Candidate ${candidate}`, exact: true }).click();
    const preview = await dialog.locator('.generation-preview canvas').evaluate(canvas => canvas.toDataURL());
    await retainPng(`${label}-preview.png`, preview); await saveReport();
    return preview;
  };
  const saveCandidate = async mode => {
    await setDestination(`${mode}-export.png`);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await dialog.locator('p[role="status"]').filter({ hasText: 'Saved image.' }).waitFor();
    const bytes = await readFile(join(outputDirectory, `${mode}-export.png`));
    report.files.push({ name: `${mode}-export.png`, bytes: bytes.length, sha256: sha256(bytes) });
    return 'data:image/png;base64,' + bytes.toString('base64');
  };
  // Only a caller that owns a separate Linux display/clipboard may supply this
  // callback. Windows deliberately omits it; no ambient clipboard is inspected.
  const copyCandidate = async (mode, preview) => {
    if(!verifyIsolatedCopy)return;
    await dialog.getByRole('button',{name:'Copy',exact:true}).click();
    await dialog.locator('p[role="status"]').filter({hasText:'Copied image.'}).waitFor();
    const copied=await verifyIsolatedCopy();
    await retainPng(`${mode}-isolated-clipboard.png`,copied);
    const diff=await compare(preview,copied);
    check(`${mode} public Copy preserves exact RGBA in the isolated native clipboard`,diff.equal,diff);
  };
  const openPhotoSelection = async () => {
    await key('Control+n'); await setDestination('photo-source.png'); await key('Control+o');
    await page.waitForFunction(() => document.title.startsWith('photo-source -'));
    await page.locator('#zoom-presets').selectOption('.5'); await frame();
    await page.locator('#viewport').evaluate(el => { el.scrollLeft = 0; el.scrollTop = 0; });
    const source = await pixels();
    await page.locator('[data-menu="selection"]').click(); await page.locator('[data-command="tool:lasso"]').click();
    const box = await page.locator('#overlay').boundingBox();
    const points = report.photoFixture.polygon;
    const move = ([x,y]) => page.mouse.move(box.x + (x + .25) * box.width / 1024, box.y + (y + .25) * box.height / 1024);
    await move(points[0]); await page.mouse.down();
    for (const point of points.slice(1)) await move(point);
    await move(points[0]); await page.mouse.up(); await frame();
    check('ordinary photo selection is made through public Free-form controls', (await page.locator('#selection-size').textContent()).trim().length > 0);
    return source;
  };
  const acceptEdit = async (mode, before, preview) => {
    const saved = await saveCandidate(mode), exportDelta = await compare(preview, saved);
    check(`${mode} Save retains exact displayed edit pixels`, exportDelta.equal, exportDelta);
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click(); await dialog.waitFor({ state: 'detached' }); await frame();
    const delta = await compare(preview, await pixels()); check(`${mode} Apply commits exact displayed preview`, delta.equal, delta);
    await key('Control+z'); check(`one ${mode} Undo restores exact prior artwork`, await pixels() === before);
    await key('Control+y'); check(`${mode} Redo restores exact accepted pixels`, (await compare(preview, await pixels())).equal);
  };
  try {
    if(!verifyIsolatedCopy)check.skip('generated candidate Copy','No isolated clipboard supplied; the host clipboard must remain untouched.');
    await sample();
    if (scope === 'all') {
      if (typeof photoFixture !== 'string' || !isAbsolute(photoFixture)) throw new Error('An explicit absolute photo fixture is required.');
      const photo = await readFile(photoFixture);
      if (sha256(photo) !== photoDigest) throw new Error('Photo fixture must be the pinned 1024 NASA astronaut edit image.');
      await retain('photo-source.png', photo);
    } else report.photoFixture = null;
    report.initial = await status();
    const modes = ['erase'];
    const configuration = report.initial.value;
    const models = modes.map(mode => configuration?.generation?.models?.[mode]);
    if (!report.initial.ok || configuration.ownsProcess || models.some(model => !model ||
        !configuration.features?.[model]?.configured || !configuration.setup?.features?.[model]?.installed) ||
        modes.some(mode => !configuration.generation.requirements?.[mode]?.every(feature => configuration.features?.[feature]?.configured))) {
      throw new Error('Installed, idle managed models are required for every requested generation workflow.');
    }
    const overrides=await main(`Object.keys(process.env).filter(key=>['SJ_PAINT_PYTHON','SJ_PAINT_U2NETP_MODEL','SJ_PAINT_EFFICIENTSAM_ENCODER','SJ_PAINT_EFFICIENTSAM_DECODER','SJ_PAINT_GENERATIVE_PYTHON','SJ_PAINT_SDXL_MODEL'].includes(key.toUpperCase()))`);
    check('managed generation has no runtime or model environment overrides',overrides.length===0,overrides);
    report.source = await main(`(() => {
      const q=__sjPaintVerification, crypto=process.mainModule.require('node:crypto');
      const root=q.path.dirname(q.path.dirname(process.mainModule.filename));
      const names=['electron/main.cjs','electron/local-ai.cjs','electron/local-ai-service.cjs','electron/generative-worker.py','electron/local-ai-worker.py','electron/ai-controller.cjs','electron/ai-assets.json'];
      const assets=q.path.join(root,'dist/assets'); for(const name of q.fs.readdirSync(assets)) if(name.endsWith('.js'))names.push('dist/assets/'+name);
      return names.map(name=>({name,sha256:crypto.createHash('sha256').update(q.fs.readFileSync(q.path.join(root,name))).digest('hex')}));
    })()`);
    await main(`(() => {
      const q=__sjPaintVerification, channel='paint:local-ai-generate', original=q.electron.ipcMain._invokeHandlers.get(channel);
      if(!original || globalThis.__sjGenerationObservation)throw new Error('Generation observer requires exclusive ownership.');
      const state={original,channel,active:null,operations:[],file:q.file}; globalThis.__sjGenerationObservation=state;
      q.electron.ipcMain.removeHandler(channel);
      q.electron.ipcMain.handle(channel,async(event,request)=>{
        const operationKey='operation-'+String(state.operations.length+1).padStart(3,'0')+'-'+request.mode;
        const entry={operationKey,startedUtc:new Date().toISOString(),request:{...request},files:[]};
        delete entry.request.png;delete entry.request.mask;
        state.operations.push(entry);state.active=request.id;
        const retain=(name,bytes)=>{q.fs.writeFileSync(q.path.join(${JSON.stringify(outputDirectory)},name),bytes,{flag:'wx'});entry.files.push(name);};
        try{
          for(const key of ['png','mask'])if(request[key])retain(operationKey+'-'+key+'-input.png',request[key]);
          const response=await original(event,request);entry.result=response.ok?{ok:true,value:{...response.value}}:response;
          if(response.ok){delete entry.result.value.png;retain(operationKey+'-worker.png',response.value.png);} return response;
        }catch(error){entry.observationError={message:error.message,code:error.code??null};throw error;
        }finally{entry.finishedUtc=new Date().toISOString();state.active=null;}
      });
    })()`); observed = true;
    let lastProgress=0;
    watcher = setInterval(() => {
      if (inFlight || guardFailure) return;
      inFlight = (async () => {
        try { const capacity=await sample();
          if(Date.now()-lastProgress>=30_000){lastProgress=Date.now();console.log(JSON.stringify({managedGenerationProgress:true,elapsedOperationMs:activeStarted?Date.now()-activeStarted:0,capacity,outputDirectory}));}
          if(activeStarted && Date.now()-activeStarted>report.limits.operationTimeoutMs)throw new Error('Generation operation exceeded its bounded runtime.'); }
        catch(error){ await cancelOwnedRequest(error.message); }
      })().catch(error => { report.monitorError=error.message; }).finally(() => { inFlight=null; });
    }, report.limits.sampleIntervalMs);

    if (scope === 'all') {
      const original = await openPhotoSelection(), originalUndo = await page.locator('[data-action="undo"]').isEnabled();
      await openGeneration('generative-erase', '');
      await sample(); activeStarted = Date.now();
      await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
      const admissionStarted = Date.now(), admissionDeadline = admissionStarted + 5000;
      let admitted, admissionStatus, admissionError;
      try {
        while (Date.now() < admissionDeadline) {
          let timer;
          try {
            [admitted, admissionStatus] = await Promise.race([
              Promise.all([main('globalThis.__sjGenerationObservation.operations.at(-1)'), status()]),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Erase admission was not observed within five seconds.')), admissionDeadline - Date.now()); }),
            ]);
          } finally { clearTimeout(timer); }
          if (guardFailure || admitted?.finishedUtc || admissionStatus?.value?.cleanupBlocked) break;
          if (admitted?.request?.mode === 'erase' && admissionStatus?.ok === true &&
              admissionStatus.value.active?.kind === 'generate' && admissionStatus.value.active.id === admitted.request.id) break;
          await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(0, admissionDeadline - Date.now()))));
        }
      } catch (error) { admissionError = error.message; }
      report.cancellationAdmission = { elapsedMs: Date.now() - admissionStarted, limitMs: 5000,
        error: admissionError ?? null, operation: admitted, state: admissionStatus };
      check('early cancellation targets the admitted observed erase operation', !admissionError && !guardFailure &&
        admitted?.request?.mode === 'erase' && !admitted.finishedUtc && admissionStatus?.ok === true &&
        admissionStatus.value.cleanupBlocked === false && admissionStatus.value.active?.kind === 'generate' &&
        admissionStatus.value.active.id === admitted.request.id, report.cancellationAdmission);
      const cancelOperationId = admitted.request.id;
      await dialog.getByRole('button', { name: 'Close', exact: true }).click(); await dialog.waitFor({ state: 'detached' }); activeStarted = 0;
      // Renderer detachment and the main-process observer settle on different
      // message queues. Observe this exact operation without issuing a second
      // cancel or release, which could conceal a failed public Close action.
      const settlementStarted = Date.now(), settlementDeadline = settlementStarted + 5000;
      let canceled, canceledStatus, settlementError;
      try {
        while (Date.now() < settlementDeadline) {
          let timer;
          try {
            [canceled, canceledStatus] = await Promise.race([
              Promise.all([main(`globalThis.__sjGenerationObservation.operations.find(operation => operation.request.id === ${JSON.stringify(cancelOperationId)})`), status()]),
              new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Public Close cancellation did not settle within five seconds.')), settlementDeadline - Date.now()); }),
            ]);
          } finally { clearTimeout(timer); }
          if (canceled?.result && (canceled.result.ok !== false || canceled.result.error?.code !== 'ABORTED')) break;
          if (guardFailure || canceledStatus?.value?.cleanupBlocked) break;
          if (canceled?.finishedUtc && canceledStatus?.ok && !canceledStatus.value.ownsProcess && !canceledStatus.value.active && !canceledStatus.value.generationSession) break;
          await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(0, settlementDeadline - Date.now()))));
        }
      } catch (error) { settlementError = error.message; }
      report.cancellationSettlement = { operationId: cancelOperationId, elapsedMs: Date.now() - settlementStarted,
        limitMs: 5000, error: settlementError ?? null, operation: canceled, state: canceledStatus };
      await saveReport();
      check('public Close cancels admitted erase and releases ownership before retry', canceled?.result?.ok === false && canceled.result.error?.code === 'ABORTED' &&
        !settlementError && !guardFailure && !!canceled.finishedUtc && canceled.request.id === cancelOperationId &&
        canceledStatus?.ok === true && canceledStatus.value.cleanupBlocked === false && !canceledStatus.value.ownsProcess && !canceledStatus.value.active && !canceledStatus.value.generationSession,
        report.cancellationSettlement);
      check('canceling erase leaves prior drawing and Undo availability unchanged', await pixels() === original && await page.locator('[data-action="undo"]').isEnabled() === originalUndo);

      for (const [mode, prompt] of [
        ['erase', ''],
      ]) {
        const source = await openPhotoSelection();
        await openGeneration(`generative-${mode}`, prompt); const edited = await generate(mode);
        const maskFile = lastOperation.files.find(name => name.endsWith('-mask-input.png'));
        const sourceFile = lastOperation.files.find(name => name.endsWith('-png-input.png'));
        if (!maskFile || !sourceFile) throw new Error('Photo edit did not retain its source and mask.');
        const mask = 'data:image/png;base64,' + (await readFile(join(outputDirectory, maskFile))).toString('base64');
        const sentSource = 'data:image/png;base64,' + (await readFile(join(outputDirectory, sourceFile))).toString('base64');
        check(`${mode} sends the opened ordinary photo unchanged to inference`, (await compare(source, sentSource)).equal);
        const delta = await compare(source, edited, null, mask);
        check(`${mode} changes selected pixels and preserves every unselected RGBA pixel`, delta.changed > 0 && delta.outsideChanged === 0, delta);
        check(`${mode} preview leaves ordinary photo uncommitted`, await pixels() === source);
        await copyCandidate(mode, edited);
        await acceptEdit(mode, source, edited);
    }

    }

    const acceptedPixels = await pixels();
    await setDestination('erase-accepted.sjpaint');
    await page.locator('[data-menu="file"]').click();
    await page.locator('[data-command="save-project"]').click();
    await page.waitForFunction(() => document.title.startsWith('erase-accepted - ') && !document.title.includes('•'));
    const acceptedProject = await readFile(join(outputDirectory, 'erase-accepted.sjpaint'));
    report.files.push({ name: 'erase-accepted.sjpaint', bytes: acceptedProject.length, sha256: sha256(acceptedProject) });
    check('accepted erase saves an editable project before closing the drawing', JSON.parse(acceptedProject.toString('utf8')).format === 'sj-paint');
    await key('Control+n');
    await page.waitForFunction(() => document.title.startsWith('Untitled - ') && !document.title.includes('•'));
    await key('Control+o');
    await page.waitForFunction(() => document.title.startsWith('erase-accepted - ') && !document.title.includes('•'));
    const reopened = await compare(acceptedPixels, await pixels());
    check('saved erase project reopens with exact accepted pixels and clean saved state', reopened.equal && !(await page.title()).includes('•'), reopened);
    await key('Control+n');
    await page.waitForFunction(() => document.title.startsWith('Untitled - ') && !document.title.includes('•'));
    report.mechanicalChecksCompleted=true;
  } catch(error) { report.failure={message:error.message,stack:error.stack}; throw error; }
  finally {
    clearInterval(watcher); if(inFlight)await inFlight;
    let cleanupFailure;
    try {
      if(observed){
        const active=await main('globalThis.__sjGenerationObservation.active');
        if(active)report.finalCancellation=await page.evaluate(id=>window.paintDesktop.localAiCancel({id}),active);
      }
      if(await dialog.count()){await dialog.getByRole('button',{name:'Close',exact:true}).click();await dialog.waitFor({state:'detached',timeout:30_000});}
      report.released=await page.evaluate(()=>window.paintDesktop.localAiRelease());report.final=await status();
      if(!(report.released.ok&&report.final.ok&&report.final.value.active===null&&report.final.value.generationSession===null&&report.final.value.ownsProcess===false&&report.final.value.cleanupBlocked===false))throw new Error('Generation still owns resources or cleanup status is unknown.');
    }catch(error){report.cleanupError=error.message;cleanupFailure=error;}
    if(observed){
      try{
        report.operations=await main('globalThis.__sjGenerationObservation.operations');
        for(const operation of report.operations)for(const name of operation.files)if(!report.files.some(file=>file.name===name)){
          const bytes=await readFile(join(outputDirectory,name));report.files.push({name,bytes:bytes.length,sha256:sha256(bytes)});
        }
      }catch(error){report.retentionError=error.message;cleanupFailure??=error;}
      finally{
        try{await main(`(()=>{const q=__sjPaintVerification,s=globalThis.__sjGenerationObservation;q.electron.ipcMain.removeHandler(s.channel);q.electron.ipcMain.handle(s.channel,s.original);q.file=s.file;delete globalThis.__sjGenerationObservation;})()`);}
        catch(error){report.observerRestoreError=error.message;cleanupFailure??=error;}
      }
    }
    report.finishedUtc=new Date().toISOString();await saveReport();
    check('real generation releases every session and worker',!cleanupFailure,report.final??report.cleanupError);
  }
}
