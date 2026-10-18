// Exercise the actual packaged preload and main-process capability boundary.
// These denied requests must never start setup, inference or a worker.
export async function verifyAiReleaseBoundaryDesktop(page, check) {
  const initial = await page.evaluate(() => window.paintDesktop.localAiStatus());
  check('packaged AI release status is available', initial?.ok === true, initial);
  const state = initial.value, generation = state.generation;
  const releasedModes = values => Array.isArray(values) && values.length === 1 &&
    [...values].sort().join(',') === 'erase';
  check('packaged generation exposes exactly erase',
    releasedModes(generation?.modes) && ['models', 'defaults', 'pipelines', 'requirements'].every(key =>
      releasedModes(Object.keys(generation?.[key] ?? {}))), generation);
  check('packaged AI excludes diffusion models, adapters and setup offers',
    !!generation?.modelDetails && !!generation?.adapters && !!state.features && !!state.setup?.features &&
    Array.isArray(state.setup.defaultFeatures) &&
    !Object.hasOwn(generation.modelDetails, 'sdxl-base') && !Object.hasOwn(generation.modelDetails, 'sdxl-coloring') &&
    !Object.hasOwn(generation.adapters, 'coloring') &&
    !Object.values(generation.modelDetails).some(model => model.adapter) &&
    !Object.values(generation.models).includes('sdxl-coloring') &&
    ['sdxl-base', 'sdxl-coloring', 'sdxl-inpaint'].every(feature => !Object.hasOwn(state.features, feature) &&
      !Object.hasOwn(state.setup.features, feature) && !state.setup.defaultFeatures.includes(feature)),
    { features: Object.keys(state.features ?? {}), modelDetails: generation?.modelDetails,
      adapters: generation?.adapters, setupFeatures: Object.keys(state.setup?.features ?? {}), defaultFeatures: state.setup?.defaultFeatures });
  const idle = result => result?.ok === true && result.value.active === null &&
    result.value.ownsProcess === false && result.value.cleanupBlocked === false &&
    result.value.generationSession === null && result.value.retainedSelection === null &&
    result.value.setup.active === null && result.value.settingUp === false;
  check('packaged AI is idle before excluded operation checks', idle(initial), initial);
  for (const mode of ['create', 'fill', 'cocreate', 'reimagine', 'sticker', 'coloring']) {
    const result = await page.evaluate(mode => window.paintDesktop.localAiGenerate({
      id: `excluded-${mode}`, mode, targetToken: 'document',
    }), mode);
    check(`packaged IPC rejects excluded ${mode} before inference`, result?.ok === false && result.error?.code === 'INPUT', result);
    const after = await page.evaluate(() => window.paintDesktop.localAiStatus());
    check(`excluded ${mode} leaves setup and worker ownership idle`, idle(after), after);
  }
}
