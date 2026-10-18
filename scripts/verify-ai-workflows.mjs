// Public editor workflows with deterministic IPC replies. These checks prove UI,
// ownership and selection handoff, not model inference or installation.
export async function verifyAiWorkflows(page, check) {
  const context = await page.context().browser().newContext({ viewport: { width: 1364, height: 820 }, deviceScaleFactor: 1 });
  const errors = [];
  let target, phase = 'open fixture';
  try {
    target = await context.newPage();
    target.on('pageerror', error => errors.push(error.message));
    await target.goto(page.url()); await target.locator('#overlay').waitFor();
    const frame = () => target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const pixels = () => target.locator('#canvas').evaluate(canvas => canvas.toDataURL());
    const key = async value => { await target.locator('#overlay').focus(); await target.keyboard.press(value); await frame(); };
    const openObject = async () => { await target.locator('[data-menu="ai"]').click(); await target.locator('#menu [data-command="object-select"]').click(); };
    const panel = target.getByRole('dialog', { name: 'Object select', exact: true });
    const setup = target.getByRole('dialog', { name: 'Set up local AI', exact: true });
    const ready = () => target.waitForFunction(() => {
      const fieldset = document.querySelector('.object-selection-dialog fieldset'); return fieldset && !fieldset.disabled;
    });
    const maskReady = () => target.waitForFunction(() => {
      const button = document.querySelector('.object-selection-dialog [type="submit"]'); return button && !button.disabled;
    });
    const point = async (x, y, down = false) => {
      const bounds = await target.locator('.object-selection-overlay').boundingBox();
      await target.mouse.move(bounds.x + (x + .25) * bounds.width / 32, bounds.y + (y + .25) * bounds.height / 24);
      if (down) await target.mouse.down(); else await target.mouse.click(bounds.x + (x + .25) * bounds.width / 32, bounds.y + (y + .25) * bounds.height / 24);
    };
    const png = await target.evaluate(() => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 64, height: 48 }), ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ccddee'; ctx.fillRect(0, 0, 64, 48);
      ctx.fillStyle = '#c03020'; ctx.fillRect(8, 6, 16, 16);
      ctx.fillStyle = '#2040c0'; ctx.fillRect(14, 12, 4, 4);
      return canvas.toDataURL().split(',')[1];
    });
    const chooser = target.waitForEvent('filechooser'); await key('Control+o');
    await (await chooser).setFiles({ name: 'object-workflow.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await target.waitForFunction(() => document.querySelector('#canvas').width === 64);
    await target.locator('#zoom-presets').selectOption('8'); await frame();
    const original = await pixels();
    await target.evaluate(() => {
      const state = { configured: true, prepares: [], prompts: [], releases: [], cancels: [], installs: [], listeners: new Set(), setupMode: 'fail-once', holdMask: false, pendingMask: null, pendingSetup: null };
      const ok = value => ({ ok: true, value }), fail = (code, message) => ({ ok: false, error: { code, message } });
      const reply = request => {
        const mask = new Uint8Array(32 * 24);
        for (let y = 3; y < 11; y++) for (let x = 4; x < 12; x++) if (!(x >= 7 && x < 9 && y >= 6 && y < 8)) mask[y * 32 + x] = 1;
        const fuller = mask.slice(), other = new Uint8Array(32 * 24);
        for(let y=3;y<11;y++)for(let x=4;x<12;x++)fuller[y*32+x]=1;
        for(let y=4;y<12;y++)for(let x=20;x<28;x++)other[y*32+x]=1;
        return ok({ sessionId: request.sessionId, targetToken: request.targetToken, width: 32, height: 24, mask, candidates:[mask,fuller,other],scores:[.9,.8,.7],selectedCandidate:0 });
      };
      window.__aiWorkflowFixture = state;
      window.paintDesktop = {
        setTitle: () => {},
        localAiStatus: async () => {
          if (state.holdSetupStatus) await new Promise(resolve => { state.releaseSetupStatus = resolve; });
          return ok({ features: { 'efficientsam-ti': { configured: state.configured } }, setup: {
            defaultFeatures: state.defaultFeatures ?? ['u2net', 'efficientsam-ti', 'migan'],
            preferredAccelerator: state.accelerator ?? 'cpu',
            features: {
              u2net: { supportsAcceleration: false, accelerator: null },
              'efficientsam-ti': { supportsAcceleration: false, accelerator: null },
              migan: { supportsAcceleration: false, accelerator: null },
              ...(state.legacyDiffusionInstalled ? { 'sdxl-coloring': { supportsAcceleration: true, accelerator: 'cuda' }, 'sdxl-base': { supportsAcceleration: true, accelerator: 'cuda' } } : {}),
            },
          }, selection: { bounds: { maxSide: 32, maxPixels: 768, maxPngBytes: 1048576, maxPromptSlots: 6 } } });
        },
        localAiPrepareSelection: async request => { state.prepares.push({ ...request, png: [...request.png] }); return ok({ sessionId: `fixture-${state.prepares.length}`, targetToken: request.targetToken, width: request.width, height: request.height }); },
        localAiSelectObject: async request => {
          state.prompts.push(structuredClone(request));
          if(!request.prompts.box && request.prompts.points.every(point=>point.label===0))return fail('INPUT','Include a foreground point or rectangle before excluding an object.');
          if(state.rejectNext){const code=state.rejectNext;state.rejectNext=null;return fail(code,`Fixture ${code} prompt failure`);}
          if (state.holdMask) return new Promise(resolve => { state.pendingMask = { id: request.id, resolve }; });
          return reply(request);
        },
        localAiReleaseSelection: async request => { state.releases.push(request); return ok({ released: true }); },
        localAiCancel: async request => { state.cancels.push(request); if (state.pendingMask?.id === request.id) { state.pendingMask.resolve(fail('ABORTED', 'Fixture canceled')); state.pendingMask = null; } return ok({ cancelled: true }); },
        localAiSetupPlan: async request => { state.plan = request;
          if (state.failPlan) return fail('RUNTIME', 'Fixture prerequisite missing. Repair and recheck.');
          return ok({ estimatedDownloadBytes: 1048576, requiredFreeBytesEstimate: 2097152, licenses: ['Fixture license'] }); },
        localAiSetup: async request => {
          state.installs.push(request);
          if (state.setupMode === 'complete') { state.configured = true; return ok({ installed: request.features }); }
          if (state.installs.length === 1) return fail('NETWORK', 'Fixture download failed. Retry setup.');
          return new Promise(resolve => { state.pendingSetup = { id: request.id, resolve }; });
        },
        localAiSetupCancel: async ({ id }) => {
          state.setupCancelled = id;
          if (state.pendingSetup?.id === id) { state.pendingSetup.resolve(fail('ABORTED', 'Fixture setup canceled')); state.pendingSetup = null; }
          if (state.holdSetupCancel) await new Promise(resolve => { state.releaseSetupCancel = resolve; });
          return ok({ cancelled: true });
        },
        onLocalAiProgress: listener => { state.listeners.add(listener); return () => state.listeners.delete(listener); },
      };
    });

    phase = 'configured object selection prompts';
    await openObject(); await ready();
    const initial = await target.evaluate(() => {
      const overlay = document.querySelector('.object-selection-overlay'), source = document.querySelector('#canvas'), dialog = document.querySelector('.object-selection-dialog');
      const a = overlay.getBoundingClientRect(), b = source.getBoundingClientRect(), prepare = window.__aiWorkflowFixture.prepares.at(-1);
      return { onStage: overlay.parentElement.id === 'stage', modal: dialog.matches(':modal'), matchingBounds: ['x', 'y', 'width', 'height'].every(key => Math.abs(a[key] - b[key]) < .1), width: prepare.width, height: prepare.height, pngSignature: prepare.png.slice(0, 8) };
    });
    check('AI IPC fixture: configured Object select opens nonmodal controls on the drawing with bounded PNG input', initial.onStage && !initial.modal && initial.matchingBounds && initial.width === 32 && initial.height === 24 && initial.pngSignature.join(',') === '137,80,78,71,13,10,26,10', initial);
    await target.locator('[data-menu="ai"]').click();
    await target.locator('#menu [data-command="ai-setup"]').click(); await frame();
    const setupAdmission = await target.evaluate(() => ({
      planRequested: Object.hasOwn(window.__aiWorkflowFixture, 'plan'),
      prepares: window.__aiWorkflowFixture.prepares.length, releases: window.__aiWorkflowFixture.releases.length,
      overlays: document.querySelectorAll('.object-selection-overlay').length,
    }));
    check('AI IPC fixture: active Object select owns the AI UI and prevents manual setup admission',
      await setup.count() === 0 && await panel.isVisible() && !setupAdmission.planRequested &&
      setupAdmission.prepares === 1 && setupAdmission.releases === 0 && setupAdmission.overlays === 1,
      setupAdmission);
    phase='exclude-first admission';
    await panel.getByLabel('Prompt type').selectOption('negative'); await point(5,4); await frame();
    const excludedFirst=await target.evaluate(()=>({disabled:document.querySelector('.object-selection-dialog fieldset').disabled,
      prompts:window.__aiWorkflowFixture.prompts.length,prepares:window.__aiWorkflowFixture.prepares.length,
      releases:window.__aiWorkflowFixture.releases.length,status:document.querySelector('.object-selection-dialog [role="status"]').textContent}));
    check('AI IPC fixture: exclude-first is explained without invalid IPC or disabling the prepared session',!excludedFirst.disabled&&excludedFirst.prompts===0&&excludedFirst.prepares===1&&excludedFirst.releases===0&&/Include.*point.*rectangle/.test(excludedFirst.status),excludedFirst);
    await panel.getByLabel('Prompt type').selectOption('point');await point(5, 4); await maskReady();
    check('AI IPC fixture: Include recovers in the same prepared session after exclude-first',await target.evaluate(()=>window.__aiWorkflowFixture.prepares.length===1&&window.__aiWorkflowFixture.releases.length===0));
    const defaultOverlay=await target.locator('.object-selection-overlay').evaluate(canvas=>canvas.toDataURL());
    const requestsBeforeChoice=await target.evaluate(()=>window.__aiWorkflowFixture.prompts.length);
    await panel.getByLabel('Selection preview',{exact:true}).selectOption('1');
    check('AI IPC fixture: alternative preview changes only the mask overlay without another decode',
      await pixels()===original&&await target.locator('.object-selection-overlay').evaluate(canvas=>canvas.toDataURL())!==defaultOverlay&&
      await target.evaluate(()=>window.__aiWorkflowFixture.prompts.length)===requestsBeforeChoice&&
      await panel.getByLabel('Selection preview',{exact:true}).inputValue()==='1');
    phase='recoverable input preserves accepted mask';
    const acceptedOverlay=await target.locator('.object-selection-overlay').evaluate(canvas=>canvas.toDataURL());
    await target.evaluate(()=>{window.__aiWorkflowFixture.rejectNext='INPUT';});await point(20,16);
    await panel.getByRole('status').filter({hasText:'Fixture INPUT prompt failure'}).waitFor();
    const recovered=await target.evaluate(()=>({disabled:document.querySelector('.object-selection-dialog fieldset').disabled,
      apply:!document.querySelector('.object-selection-dialog [type="submit"]').disabled,prepares:window.__aiWorkflowFixture.prepares.length,releases:window.__aiWorkflowFixture.releases.length}));
    check('AI IPC fixture: recoverable INPUT retains exact accepted alternative, overlay and worker session',!recovered.disabled&&recovered.apply&&recovered.prepares===1&&recovered.releases===0&&await target.locator('.object-selection-overlay').evaluate(canvas=>canvas.toDataURL())===acceptedOverlay&&await pixels()===original&&await panel.getByLabel('Selection preview',{exact:true}).inputValue()==='1',recovered);
    await panel.getByRole('button',{name:'Clear prompts',exact:true}).click();
    const clearedOverlay=await target.locator('.object-selection-overlay').evaluate(canvas=>canvas.toDataURL());
    await target.evaluate(()=>{window.__aiWorkflowFixture.rejectNext='INPUT';});await point(20,16);
    await panel.getByRole('status').filter({hasText:'Fixture INPUT prompt failure'}).waitFor();
    check('AI IPC fixture: rejected input after Clear cannot resurrect a discarded mask',await panel.getByRole('button',{name:'Apply',exact:true}).isDisabled()&&!await panel.locator('fieldset').evaluate(fieldset=>fieldset.disabled)&&await target.locator('.object-selection-overlay').evaluate(canvas=>canvas.toDataURL())===clearedOverlay);
    await point(5,4);await maskReady();
    phase='configured object selection prompts';
    await panel.getByLabel('Prompt type').selectOption('negative'); await point(15, 12); await maskReady();
    await panel.getByLabel('Prompt type').selectOption('box');
    await point(3, 2, true);
    const overlayBounds = await target.locator('.object-selection-overlay').boundingBox();
    await target.mouse.move(overlayBounds.x + 13.25 * overlayBounds.width / 32, overlayBounds.y + 12.25 * overlayBounds.height / 24, { steps: 4 }); await target.mouse.up(); await maskReady();
    const prompts = await target.evaluate(() => window.__aiWorkflowFixture.prompts.at(-1).prompts);
    check('AI IPC fixture: drawing clicks send include/exclude points and the dragged box in preview coordinates', JSON.stringify(prompts) === JSON.stringify({ points: [{ x: 5, y: 4, label: 1 }, { x: 15, y: 12, label: 0 }], box: { x1: 3, y1: 2, x2: 13, y2: 12 } }), prompts);
    check('AI IPC fixture: mask preview leaves original rendered pixels unchanged', await pixels() === original);
    await panel.getByRole('button', { name: 'Apply', exact: true }).click(); await panel.waitFor({ state: 'detached' }); await frame();
    const applied = await target.evaluate(() => ({ selection: document.querySelector('#selection-size').textContent, overlays: document.querySelectorAll('.object-selection-overlay').length, releases: window.__aiWorkflowFixture.releases.length }));
    check('AI IPC fixture: Apply maps the reduced mask to a full-resolution ordinary selection and releases the session', applied.selection === '16 × 16px' && applied.overlays === 0 && applied.releases === 1, applied);
    await key('Shift+ArrowRight'); await key('Control+Space');
    const moved = await pixels();
    check('AI IPC fixture: ordinary selection move changes the artwork', moved !== original);
    await key('Control+z'); check('AI IPC fixture: one Undo restores exact pre-object-selection pixels', await pixels() === original);
    await key('Control+y'); check('AI IPC fixture: Redo restores exact moved pixels', await pixels() === moved);
    await key('Control+z');

    phase = 'object selection Delete and Undo';
    await openObject(); await ready(); await point(5, 4); await maskReady();
    await panel.getByRole('button', { name: 'Apply', exact: true }).click(); await panel.waitFor({ state: 'detached' });
    await key('Delete');
    const deleted = await pixels();
    const deletion = await target.evaluate(async ({ before, after }) => {
      const decode = async url => { const image = new Image(); image.src = url; await image.decode(); const canvas = Object.assign(document.createElement('canvas'), { width: 64, height: 48 }); const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); return ctx.getImageData(0, 0, 64, 48).data; };
      const a = await decode(before), b = await decode(after); let outsideChanged = 0, selectedNotCleared = 0, selected = 0;
      for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) {
        const offset = (y * 64 + x) * 4, owned = x >= 8 && x < 24 && y >= 6 && y < 22 && !(x >= 14 && x < 18 && y >= 12 && y < 16);
        if (owned) { selected++; if (b[offset + 3] !== 0) selectedNotCleared++; }
        else if (!a.subarray(offset, offset + 4).every((value, channel) => value === b[offset + channel])) outsideChanged++;
      }
      return { selected, selectedNotCleared, outsideChanged };
    }, { before: original, after: deleted });
    check('AI IPC fixture: Delete clears only mapped mask pixels and preserves its unselected hole', deletion.selected === 240 && deletion.selectedNotCleared === 0 && deletion.outsideChanged === 0, deletion);
    await key('Control+z'); check('AI IPC fixture: Delete Undo restores exact original pixels', await pixels() === original);
    await key('Control+y'); check('AI IPC fixture: Delete Redo restores exact deletion', await pixels() === deleted);
    await key('Control+z');

    phase = 'pending object selection cancellation';
    await target.evaluate(() => { window.__aiWorkflowFixture.holdMask = true; });
    await openObject(); await ready(); await point(5, 4);
    await target.waitForFunction(() => !!window.__aiWorkflowFixture.pendingMask);
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click(); await panel.waitFor({ state: 'detached' }); await frame();
    const canceled = await target.evaluate(() => ({ pending: !!window.__aiWorkflowFixture.pendingMask, cancels: window.__aiWorkflowFixture.cancels.length, releases: window.__aiWorkflowFixture.releases.length, overlays: document.querySelectorAll('.object-selection-overlay').length, selection: document.querySelector('#selection-size').textContent }));
    check('AI IPC fixture: Cancel retires the pending decode and session with no overlay or selection left', !canceled.pending && canceled.cancels === 1 && canceled.releases === 3 && canceled.overlays === 0 && canceled.selection === '', canceled);
    check('AI IPC fixture: cancellation preserves exact original pixels and the Redo branch', await pixels() === original && await target.locator('[data-action="redo"]').isEnabled());

    phase = 'unconfigured setup failure retry and cancel';
    await target.evaluate(() => { window.__aiWorkflowFixture.configured = false; window.__aiWorkflowFixture.holdMask = false; window.__aiWorkflowFixture.failPlan = true; });
    await openObject(); await setup.waitFor();
    await setup.getByRole('button', { name: 'Recheck setup', exact: true }).waitFor();
    check('AI IPC fixture: a failed plan explains the prerequisite and prevents installation',
      (await setup.locator('.ai-setup-plan').textContent()).includes('Fixture prerequisite missing') && await setup.getByRole('button', { name: 'Install', exact: true }).isDisabled());
    await target.evaluate(() => { window.__aiWorkflowFixture.failPlan = false; });
    await setup.getByRole('button', { name: 'Recheck setup', exact: true }).focus(); await target.keyboard.press('Enter');
    await target.waitForFunction(() => !document.querySelector('.ai-dialog [type="submit"]').disabled);
    check('AI IPC fixture: keyboard Recheck recovers the same setup dialog after prerequisite repair', await setup.count() === 1 && await setup.getByRole('button', { name: 'Recheck setup', exact: true }).isHidden());
    check('AI IPC fixture: unconfigured Object select offers bounded setup before preparing an image', await panel.count() === 0 && await setup.locator('.ai-setup-plan').textContent() === '1.0 MiB estimated download; 2.0 MiB free space required. Licenses: Fixture license.');
    await setup.getByRole('button', { name: 'Install', exact: true }).click();
    await target.waitForFunction(() => document.querySelector('.ai-setup-progress')?.textContent === 'Fixture download failed. Retry setup.');
    check('AI IPC fixture: setup failure exposes its reason and enables retry', await setup.getByRole('button', { name: 'Install', exact: true }).isEnabled());
    await setup.getByRole('button', { name: 'Install', exact: true }).click();
    await target.waitForFunction(() => !!window.__aiWorkflowFixture.pendingSetup);
    check('AI IPC fixture: running setup exposes a named progress bar', await setup.getByRole('progressbar', { name: 'Local AI setup progress', exact: true }).count() === 1);
    await target.evaluate(() => { const s = window.__aiWorkflowFixture; for (const listener of s.listeners) listener({ id: 'unrelated', stage: 'Wrong operation', completed: 99, total: 100 }); });
    check('AI IPC fixture: setup ignores progress belonging to another operation', await setup.locator('.ai-setup-progress').textContent() === 'Preparing setup…');
    await target.evaluate(() => { const s = window.__aiWorkflowFixture; for (const listener of s.listeners) listener({ id: s.pendingSetup.id, kind: 'setup', progress: { stage: 'downloading', artifact: 'fixture-model', completed: 5, total: 10 } }); });
    check('AI IPC fixture: setup displays matching progress and prevents duplicate installs', await setup.locator('.ai-setup-progress').textContent() === 'Downloading: fixture-model' && await setup.locator('progress').evaluate(el => el.value === 5 && el.max === 10) && await setup.getByRole('button', { name: 'Install', exact: true }).isDisabled());
    await target.evaluate(() => { __aiWorkflowFixture.holdSetupCancel = true; });
    await setup.getByRole('button', { name: 'Cancel', exact: true }).click();
    await target.waitForFunction(() => !!__aiWorkflowFixture.releaseSetupCancel && !__aiWorkflowFixture.pendingSetup); await frame();
    check('AI IPC fixture: delayed Cancel keeps Install unavailable after the aborted setup settles',
      await setup.getByRole('button', { name: 'Install', exact: true }).isDisabled() &&
      await setup.getByRole('button', { name: 'Cancel', exact: true }).isDisabled());
    await target.evaluate(() => { __aiWorkflowFixture.holdSetupCancel = false; __aiWorkflowFixture.releaseSetupCancel(); });
    await setup.waitFor({ state: 'detached' });
    const setupCanceled = await target.evaluate(() => ({ id: window.__aiWorkflowFixture.setupCancelled, pending: !!window.__aiWorkflowFixture.pendingSetup, listeners: window.__aiWorkflowFixture.listeners.size, overlays: document.querySelectorAll('.object-selection-overlay').length }));
    check('AI IPC fixture: setup cancellation retires its operation and progress listener without entering object selection', !!setupCanceled.id && !setupCanceled.pending && setupCanceled.listeners === 0 && setupCanceled.overlays === 0, setupCanceled);

    phase = 'successful setup continuation';
    await target.evaluate(() => { window.__aiWorkflowFixture.setupMode = 'complete'; });
    await openObject(); await setup.waitFor();
    await target.waitForFunction(() => !document.querySelector('.ai-dialog [type="submit"]').disabled);
    await setup.getByRole('button', { name: 'Install', exact: true }).click(); await setup.waitFor({ state: 'detached' }); await ready();
    check('AI IPC fixture: successful setup continues into prepared Object select and removes setup listeners', await target.evaluate(() => window.__aiWorkflowFixture.configured && window.__aiWorkflowFixture.listeners.size === 0 && window.__aiWorkflowFixture.prepares.length === 4));
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click(); await panel.waitFor({ state: 'detached' });
    check('AI IPC fixture: completed setup and canceled object preview preserve artwork', await pixels() === original);
    for(const code of ['RUNTIME','CLEANUP']){
      phase=`fatal ${code} remains distinct from prompt INPUT`;
      await openObject();await ready();await target.evaluate(code=>{window.__aiWorkflowFixture.rejectNext=code;},code);await point(5,4);
      await panel.getByRole('status').filter({hasText:`Fixture ${code} prompt failure`}).waitFor();
      const blocked={fieldset:await panel.locator('fieldset').evaluate(fieldset=>fieldset.disabled),apply:await panel.getByRole('button',{name:'Apply',exact:true}).isDisabled(),pixelsUnchanged:await pixels()===original};
      check(`AI IPC fixture: ${code} failure still blocks unsafe Apply and refinement`,blocked.fieldset&&blocked.apply&&blocked.pixelsUnchanged,blocked);
      await panel.getByRole('button',{name:'Cancel',exact:true}).click();await panel.waitFor({state:'detached'});
    }
    phase='alternative Apply uses the chosen mask';
    await openObject();await ready();await point(5,4);await maskReady();
    await panel.getByLabel('Selection preview',{exact:true}).selectOption('1');
    await panel.getByRole('button',{name:'Apply',exact:true}).click();await panel.waitFor({state:'detached'});
    await key('Delete');
    const alternativeDelete=await target.evaluate(async original=>{
      const decode=async url=>{const image=new Image();image.src=url;await image.decode();const canvas=Object.assign(document.createElement('canvas'),{width:64,height:48}),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return ctx.getImageData(0,0,64,48).data;};
      const before=await decode(original),after=await decode(document.querySelector('#canvas').toDataURL());let outsideChanged=0,selectedNotCleared=0;
      for(let y=0;y<48;y++)for(let x=0;x<64;x++){const offset=(y*64+x)*4;if(x>=8&&x<24&&y>=6&&y<22){if(after[offset+3]!==0)selectedNotCleared++;}else if(!before.subarray(offset,offset+4).every((value,index)=>value===after[offset+index]))outsideChanged++;}
      return {outsideChanged,selectedNotCleared};
    },original);
    check('AI IPC fixture: Apply uses the fuller alternative including the former hole and preserves outside pixels',alternativeDelete.outsideChanged===0&&alternativeDelete.selectedNotCleared===0,alternativeDelete);
    await key('Control+z');check('AI IPC fixture: one Undo restores the source after chosen-alternative Delete',await pixels()===original);
    phase='alternative cancellation and pending refinement';
    await openObject();await ready();await point(5,4);await maskReady();
    await panel.getByLabel('Selection preview',{exact:true}).selectOption('2');
    check('AI IPC fixture: a preview missing an Include point explains the refinement limitation',await panel.getByRole('status').textContent()==='An Include point is outside this preview. Try another preview or refine the prompts.');
    await target.evaluate(()=>{window.__aiWorkflowFixture.holdMask=true;});await point(6,4);
    await target.waitForFunction(()=>!!window.__aiWorkflowFixture.pendingMask);
    check('AI IPC fixture: pending refinement cannot select an obsolete alternative',await panel.getByLabel('Selection preview',{exact:true}).isHidden()&&await panel.getByRole('button',{name:'Apply',exact:true}).isDisabled());
    await panel.getByRole('button',{name:'Cancel',exact:true}).click();await panel.waitFor({state:'detached'});
    check('AI IPC fixture: Cancel after switching alternatives preserves source, Redo and removes the overlay',await pixels()===original&&await target.locator('[data-action="redo"]').isEnabled()&&await target.locator('.object-selection-overlay').count()===0);
    phase = 'released CPU setup and preserved legacy profiles';
    const openSetup = async () => {
      await target.locator('[data-menu="ai"]').click(); await target.locator('[data-command="ai-setup"]').click(); await setup.waitFor();
    };
    for (const legacy of [false, true]) {
      await target.evaluate(legacy => { __aiWorkflowFixture.legacyDiffusionInstalled = legacy; __aiWorkflowFixture.accelerator = legacy ? 'cuda' : 'cpu'; }, legacy);
      await openSetup(); await target.waitForFunction(() => !document.querySelector('.ai-dialog [type="submit"]').disabled);
      check(`AI IPC fixture: ${legacy ? 'preserved legacy diffusion profiles do not change' : 'fresh setup offers only'} released CPU features`,
        await setup.getByLabel('Image generation hardware').isHidden() &&
        await target.evaluate(() => JSON.stringify([...__aiWorkflowFixture.plan.features].sort()) === JSON.stringify(['efficientsam-ti', 'migan', 'u2net'])));
      await setup.getByRole('button', { name: 'Cancel', exact: true }).click(); await setup.waitFor({ state: 'detached' });
    }
    check('AI IPC fixture workflows have no browser errors', errors.length === 0, errors);
  } catch (error) {
    const detail = await target?.evaluate(() => ({ dialogs: [...document.querySelectorAll('dialog[open]')].map(el => el.textContent),
      overlays: document.querySelectorAll('.object-selection-overlay').length, selection: document.querySelector('#selection-size')?.textContent,
      prepares: window.__aiWorkflowFixture?.prepares.length, prompts: window.__aiWorkflowFixture?.prompts.length,
      installs: window.__aiWorkflowFixture?.installs.length, toast: document.querySelector('#toast')?.textContent })).catch(() => null);
    check(`AI IPC fixture failed during ${phase}`, false, { error: error.message, errors, detail });
    throw error;
  } finally { await context.close(); }
}
