// This isolates caret geometry from viewport scrolling. The reference preserves
// the source text, including its existing word-break opportunities.
export async function verifyTextCaretLayout(page, check) {
  const results = await page.evaluate(async () => {
    const { measureTextCaret } = await import('/src/text-layout.js');
    const fixtures = [
      { name: 'empty input', text: '', index: 0 },
      { name: 'text start', text: 'abc', index: 0 },
      { name: 'text end', text: 'abc', index: 3 },
      { name: 'trailing newline', text: 'abc\n', index: 4 },
      { name: 'interior empty line', text: 'a\n\nb', index: 2 },
      { name: 'after newline', text: 'a\nb', index: 2 },
      { name: 'midword after wrapping', text: 'abc abcdefghijk', index: 9 },
    ];
    const results = [];
    for (const fixture of fixtures) {
      const editor = document.createElement('textarea'), mirror = document.createElement('div');
      const css = { position: 'fixed', left: '0', top: '0', width: '144px', height: 'auto',
        minHeight: '0', font: '20px monospace', lineHeight: '24px', padding: '0', margin: '0', border: '0',
        boxSizing: 'content-box', whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
        visibility: 'hidden', letterSpacing: '0px', wordSpacing: '0px' };
      Object.assign(editor.style, css); Object.assign(mirror.style, css);
      editor.value = fixture.text; editor.setSelectionRange(fixture.index, fixture.index);
      const node = document.createTextNode(fixture.text); mirror.append(node);
      // Final baseline marker keeps the empty last line without adding text or
      // changing word-break opportunities inside the source.
      const end = document.createElement('span');
      Object.assign(end.style, { display: 'inline-block', width: '0', height: '0', verticalAlign: 'baseline' });
      mirror.append(end); document.body.append(editor, mirror);
      try {
        const range = document.createRange(); range.setStart(node, fixture.index); range.collapse(true);
        const rect = range.getClientRects()[0] || range.getBoundingClientRect();
        const origin = mirror.getBoundingClientRect(), actual = measureTextCaret(editor);
        // Explicit lines provide an independent vertical oracle for zero-height
        // collapsed ranges (empty input and an empty final line).
        const explicitLine = fixture.text.slice(0, fixture.index).split('\n').length - 1;
        const top = rect.height > 0 ? rect.top - origin.top : explicitLine * 24;
        const bottom = rect.height > 0 ? rect.bottom - origin.top : (explicitLine + 1) * 24;
        const expected = { left: rect.height > 0 ? rect.left - origin.left : 0, top, bottom };
        const exact = rect.height > 0;
        const valid = !!actual && actual.bottom > actual.top &&
          (exact ? actual.left === expected.left && actual.top === top && actual.bottom === bottom :
            actual.top >= top && actual.bottom <= bottom);
        results.push({ name: fixture.name, actual, expected, collapsedHeight: rect.height, valid });
      } finally { editor.remove(); mirror.remove(); }
    }
    return results;
  });
  check('caret geometry preserves native wrapping, explicit blank lines and empty endpoints',
    results.every(result => result.valid), results);
}
