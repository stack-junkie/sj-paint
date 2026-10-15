# Paint parity and evidence

The requested target is a 1:1 Linux recreation of Microsoft Paint. This implementation is a runnable independent editor, but that full target is not complete.

## Reference

The reference is Windows 11 Microsoft.Paint 11.2605.81.0. [REA](https://github.com/morluto/rea) was used for static executable resource inspection alongside UI observation. Resource inspection establishes inventory and executable identity, not behavior parity.

The reference showed the modern toolbar, selection/image/tool/brush/shape/color groups, layers panel and zoom/status layout. The implementation uses newly drawn icons and independent rendering code. Microsoft binaries, icons, and model weights are not bundled.

## Implemented

- Modern dark and light layouts, palette and custom colors, tool sizes, opacity, zoom, grid, rulers, full screen, collapsible toolbar and layers panel.
- Pencil, brush, eraser, calligraphy variants, airbrush, oil, crayon, marker, natural pencil and watercolor. Textures and rasterization are independent approximations.
- 23 shapes, two-control-point curves, polygon construction, outline/fill styles, constrained shapes and lines.
- Fill tolerance, color picker, multiline text with font/size/bold/italic/underline/alignment/background.
- Rectangular and free-form selections, inverse selection, color-key transparency for new selections, color inversion, move/resize/crop, copy/cut/paste, image rotation, flips, resize/skew and canvas dimensions.
- Layer add/delete/duplicate/reorder/rename, opacity, visibility, merge and transparent background.
- Undo/redo with saved-state identity, editable .linuxpaint projects, native file dialogs, image export and print integration.
- PNG, JPEG, WebP, BMP, GIF and TIFF export. PNG/JPEG/WebP/BMP/GIF import uses Chromium decoding. GIF is a single frame; TIFF import is absent.

## Still different or unresolved

| Area | Boundary |
| --- | --- |
| Microsoft AI | Cocreator, Image Creator, generative fill/erase, object selection and AI background removal are not implemented. No Microsoft service access or replacement provider was chosen. |
| Microsoft .paint format | No compatible reader/writer or sample project round-trip. .linuxpaint preserves this editor's layers but is a different format. |
| Exact behavior | Exact brush rasterization, selection and transform edge cases, text metrics, color management, metadata, codec variants and all command shortcuts are not proven identical. |
| Visual fidelity | Layout follows the captured modern reference. Icons are newly drawn, fonts depend on Linux availability, and some controls differ. No pixel-perfect reference comparison. |
| Advanced editing | Post-commit vector/text re-editing and Microsoft's free-rotation handle behavior are not reproduced. |
| Platform integration | Share/account/cloud features are absent. Native chooser appearance, physical printing, Wayland, accessibility completeness and ARM are not verified. |
| Limits | App-specific document/history/encoded-file bounds differ from unknown Paint limits. |

## Executed verification

`output/verification.json` records headless Chrome UI and canvas checks. `output/linux-verification.json` records the packaged x64 Electron app running under Ubuntu 22.04 Xvfb, including native IPC file round-trips and its private clipboard. File chooser responses were controlled by the harness; real encoding, filesystem operations and decoding ran. `output/paint-linux-runtime.png` is the Linux renderer capture.

Build success and these checks do not establish 1:1 parity or full desktop compatibility.
