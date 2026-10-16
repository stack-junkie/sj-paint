export const STANDARD_FONTS = ['Arial', 'Verdana', 'Georgia', 'Times New Roman', 'Courier New', 'Trebuchet MS', 'serif', 'sans-serif', 'monospace'];
const genericFamilies = new Set(['serif', 'sans-serif', 'monospace']);
export const fontFamilyCss = name => genericFamilies.has(name) ? name : JSON.stringify(name);

async function discoverFonts() {
  if (window.paintDesktop?.listFonts) return window.paintDesktop.listFonts();
  // Browser font access is optional and privacy-gated. Never prompt merely
  // because the user selects Text; reuse only an already granted permission.
  if (window.queryLocalFonts && navigator.permissions) {
    const permission = await navigator.permissions.query({ name: 'local-fonts' });
    if (permission.state === 'granted') return { ok: true, source: 'browser', families: (await window.queryLocalFonts()).map(font => font.family) };
  }
  return { ok: false, message: 'Standard fonts. Installed-font access is unavailable or has not been granted.' };
}

export function bindFontPicker(select) {
  let pending;
  return function load() {
    if (pending) return pending;
    select.dataset.fontCatalog = 'loading';
    pending = discoverFonts().then(result => {
      if (!result?.ok) throw new Error(result?.message || 'Installed fonts could not be loaded.');
      if (!Array.isArray(result.families) || !result.families.length || result.families.some(name => typeof name !== 'string' || !name.trim() || /[\u0000-\u001f\u007f]/.test(name))) throw new Error('The installed-font list could not be read.');
      const apply = () => {
        const current = select.value;
        const names = [...new Set([...result.families, ...STANDARD_FONTS, current])].sort((a, b) => a.localeCompare(b) || (a < b ? -1 : a > b ? 1 : 0));
        const options = names.map(name => {
          const option = document.createElement('option'); option.value = option.textContent = name; option.style.fontFamily = fontFamilyCss(name); return option;
        });
        select.replaceChildren(...options); select.value = current;
        select.dataset.fontCatalog = 'ready'; select.title = 'Installed fonts and standard families. Restart to refresh installed fonts.';
      };
      // Do not replace a native select's open choices or its type-to-jump state.
      if (document.activeElement === select) select.addEventListener('blur', apply, { once: true });
      else apply();
    }).catch(error => {
      select.dataset.fontCatalog = 'unavailable'; select.title = error.message || 'Installed fonts could not be loaded. The standard list is still available.';
    });
    return pending;
  };
}
