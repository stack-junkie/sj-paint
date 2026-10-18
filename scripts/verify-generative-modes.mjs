// Public editor controls with deterministic inference and output adapters.
// This proves request semantics, exports and editing/history, not AI quality.
export async function verifyGenerativeModes(page, check) {
  const context = await page.context().browser().newContext({ viewport: { width: 1364, height: 820 }, deviceScaleFactor: 1 });
  const errors = [];
  try {
    const target = await context.newPage();
    target.on('pageerror', error => errors.push(error.message));
    await target.goto(page.url()); await target.locator('#overlay').waitFor();
    await target.evaluate(async () => {
      const canvas = Object.assign(document.createElement('canvas'), { width: 64, height: 64 }), ctx = canvas.getContext('2d');
      ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 64, 64); ctx.fillStyle = '#315980'; ctx.fillRect(20, 20, 16, 16);
      const blob = await new Promise(resolve => canvas.toBlob(resolve));
      const state = window.__modeVerification = { source: new Uint8Array(await blob.arrayBuffer()), calls: [], generated: 0, session: null, name: 'source.png' };
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        write: async items => { state.copied = new Uint8Array(await (await items[0].getType('image/png')).arrayBuffer()); },
      } });
      window.paintDesktop = {
        setTitle() {}, confirmSaveChanges: async () => 'discard',
        openImage: async () => ({ bytes: state.source, name: state.name, target: 'mode-source', targetFormat: 'png' }),
        saveImage: async request => { state.saved = request; return { name: request.suggestedName }; },
        localAiSetup() {},
        localAiStatus: async () => ({ ok: true, value: { features: { migan: { configured: true } }, generation: {
          requirements: { erase: ['migan'] },
          defaults: Object.fromEntries(['erase'].map(mode => [mode, { steps: 30, guidance: 7.5, strength: 1 }])),
          bounds: { maxPromptBytes: 1536, minSteps: 1, maxSteps: 50 },
        } } }),
        localAiGenerate: async request => {
          state.calls.push(request);
          if (state.failNext) { state.failNext = false; return { ok: false, error: { code: 'GENERATION', message: 'Controlled generation failure.' } }; }
          state.session ||= crypto.randomUUID(); state.generated++;
          const output = Object.assign(document.createElement('canvas'), { width: request.width, height: request.height });
          output.getContext('2d').fillStyle = state.generated % 2 ? '#28a46b' : '#ae378e';
          output.getContext('2d').fillRect(0, 0, output.width, output.height);
          const png = await new Promise(resolve => output.toBlob(resolve));
          return { ok: true, value: { width: output.width, height: output.height, targetToken: request.targetToken,
            png: new Uint8Array(await png.arrayBuffer()), sessionId: state.session, candidateId: crypto.randomUUID(), seed: request.seed } };
        },
        localAiCancel: async () => ({ ok: false, error: { code: 'NOT_FOUND', message: 'No pending controlled request.' } }),
        localAiReleaseGeneration: async () => { state.session = null; return { ok: true, value: {} }; },
        localAiRelease: async () => { state.session = null; return { ok: true, value: {} }; },
        onLocalAiProgress: () => () => {},
      };
    });
    const frame = () => target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const pixels = () => target.locator('#canvas').evaluate(canvas => canvas.toDataURL());
    const key = async value => { await target.locator('#overlay').focus(); await target.keyboard.press(value); await frame(); };
    const panel = target.locator('.generation-dialog');
    const openSource = async name => {
      await target.evaluate(name => { __modeVerification.name = name + '.png'; }, name);
      await key('Control+o'); await target.waitForFunction(name => document.title.startsWith(name + ' -'), name); await frame();
    };
    const openMode = async command => {
      await target.locator('[data-menu="ai"]').click(); await target.locator(`[data-command="${command}"]`).click(); await panel.waitFor();
    };
    const generate = async () => {
      await panel.getByRole('button', { name: 'Generate', exact: true }).click();
      await target.waitForFunction(() => !document.querySelector('.generation-dialog [type="submit"]').disabled);
    };
    const preview = () => panel.locator('.generation-preview canvas').evaluate(canvas => canvas.toDataURL());
    const request = () => target.evaluate(async () => {
      const value = __modeVerification.calls.at(-1);
      const sourceHash = value.png ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', value.png))].map(x => x.toString(16).padStart(2, '0')).join('') : null;
      return { mode: value.mode, prompt: value.prompt, strength: value.strength, guidance: value.guidance, steps: value.steps, sourceHash, hasMask: !!value.mask, width: value.width, height: value.height };
    });
    const outputs = async expected => {
      await panel.getByRole('button', { name: 'Save', exact: true }).click(); await panel.getByRole('status').filter({ hasText: 'Saved image.' }).waitFor();
      await panel.getByRole('button', { name: 'Copy', exact: true }).click(); await panel.getByRole('status').filter({ hasText: 'Copied image.' }).waitFor();
      const result = await target.evaluate(async () => {
        const { readImageResolution } = await import('/src/image-metadata.js');
        const decode = async bytes => {
          const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
          const canvas = Object.assign(document.createElement('canvas'), { width: image.width, height: image.height });
          canvas.getContext('2d').drawImage(image, 0, 0); image.close(); return canvas.toDataURL();
        };
        return { saved: await decode(__modeVerification.saved.bytes), copied: await decode(__modeVerification.copied), resolution: readImageResolution(__modeVerification.saved.bytes) };
      });
      check('Unknown source/output density stays unknown in candidate PNG', result.resolution.xDpi === null && result.resolution.yDpi === null, result.resolution);
      return result.saved === expected && result.copied === expected;
    };
    const point = async (x, y) => {
      const box = await target.locator('#overlay').boundingBox(); return { x: box.x + (x + .25) * box.width / 64, y: box.y + (y + .25) * box.height / 64 };
    };
    const drag = async (tool, from, to) => {
      await target.locator(`[data-tool="${tool}"]`).click(); const a = await point(...from), b = await point(...to);
      await target.mouse.move(a.x, a.y); await target.mouse.down(); await target.mouse.move(b.x, b.y, { steps: 4 }); await target.mouse.up(); await frame();
    };

    await target.locator('[data-menu="ai"]').click();
    const menuCommands = await target.locator('#menu [data-command]').evaluateAll(items => items.map(item => item.dataset.command));
    check('Release AI menu retains supported actions and omits excluded generation actions',
      ['object-select', 'generative-erase', 'ai-setup'].every(command => menuCommands.includes(command)) &&
      ['create-image', 'stickers', 'coloring-pages', 'cocreator', 'generative-fill', 'reimagine'].every(command => !menuCommands.includes(command)), menuCommands);
    await target.keyboard.press('Escape');
    const excluded = await target.evaluate(async () => {
      const { generateImage } = await import('/src/generative-ai.js');
      const results = [];
      for (const mode of ['create', 'fill', 'cocreate', 'reimagine', 'sticker', 'coloring']) {
        try { await generateImage(null, mode); results.push(false); } catch { results.push(true); }
      }
      return results.every(Boolean) && __modeVerification.calls.length === 0 && !document.querySelector('.generation-dialog');
    });
    check('Excluded renderer entrypoints reject before setup or generation', excluded);
    await openSource('erase-source'); const eraseSource = await pixels(); await drag('select', [16, 16], [40, 40]);
    await openMode('generative-erase'); await target.evaluate(() => { __modeVerification.failNext = true; }); await generate();
    check('Erase works without diffusion setup, hides the prompt and surfaces a retryable failure', (await request()).prompt === '' && await panel.locator('[name="prompt"]').isHidden() &&
      (await panel.getByRole('status').textContent()).includes('Controlled generation failure') && await panel.locator('.generation-preview canvas').count() === 0 && await pixels() === eraseSource);
    await generate(); const erased = await preview(); await generate();
    await panel.getByRole('button', { name: 'Candidate 1', exact: true }).click();
    check('Erase retry and candidate selection preserve the first chosen preview', await preview() === erased && (await request()).mode === 'erase' && (await request()).hasMask);
    check('Erase Save and isolated Copy preserve the full selected preview', await outputs(erased));
    check('Erase exports leave the original drawing unchanged', await pixels() === eraseSource);
    await panel.getByRole('button', { name: 'Apply', exact: true }).click(); await panel.waitFor({ state: 'detached' }); await frame();
    const eraseApplied = await pixels();
    const region = await target.evaluate(async ({ before, after }) => {
      const decode = async png => { const image = new Image(); image.src = png; await image.decode(); const c = Object.assign(document.createElement('canvas'), { width: 64, height: 64 }); const x = c.getContext('2d'); x.drawImage(image, 0, 0); return x.getImageData(0, 0, 64, 64).data; };
      const a = await decode(before), b = await decode(after); let inside = 0, outside = 0;
      for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { const i = (y * 64 + x) * 4; if (a.subarray(i, i + 4).some((v, j) => v !== b[i + j])) { if (x >= 16 && x < 40 && y >= 16 && y < 40) inside++; else outside++; } }
      return { inside, outside };
    }, { before: eraseSource, after: eraseApplied });
    check('Erase Apply exactly preserves unselected pixels and changes the selected region', region.inside === 24 * 24 && region.outside === 0 && eraseApplied === erased, region);
    await key('Control+z'); check('Erase Undo restores the exact original saved image', await pixels() === eraseSource && await target.locator('[data-action="undo"]').isDisabled());
    await key('Control+y'); check('Erase Redo restores the accepted region', await pixels() === eraseApplied);

    check('Additional generation mode workflows have no page errors', errors.length === 0, errors);
  } finally { await context.close(); }
}
