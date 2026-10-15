# Microsoft Paint baseline: parity and verification

Stack Junkie Paint (SJ Paint) is an independent drawing editor with Windows as its primary desktop platform, Linux support and a browser edition. The baseline goal is to match Microsoft Paint in every possible way, including its appearance, features and behavior. That goal remains unfinished. Renaming the app does not reduce the baseline scope. Project-specific extensions come after the baseline is completed and verified.

## Initial reference

The initial reference was Windows 11 Microsoft.Paint 11.2605.81.0. [REA](https://github.com/morluto/rea) was used for static executable resource inspection alongside UI observation. That inspection established resource inventory and executable identity, not equivalent behavior.

The reference informed the toolbar, selection/image/tool/brush/shape/color groups, layers panel and zoom/status layout. The implementation uses newly drawn icons and independent rendering code. Microsoft binaries, icons and model weights are not bundled.

## Interaction comparison, 2026-10-15

Reference: installed Microsoft.Paint 11.2605.81.0, a separate disposable Untitled window. The owner's existing drawing was not edited. SJ Paint comparison starts from 0.2.0.

| Scenario | Reference evidence | SJ Paint result |
| --- | --- | --- |
| Canvas resize feedback, issue #1 | Owner reported the live outline and changing pixel dimensions. Direct observation confirmed eight handles, final dimensions, and top-left growth translating artwork to preserve opposite edges. | 0.2.1 adds all eight handles, a transient outline and live dimensions. Shared browser/desktop tests inspect the held-pointer state before release, then commit and undo. |
| Resize cancellation and limits | Exact Paint Escape, capture-loss and resource-limit behavior has not been captured. | SJ Paint explicitly cancels an interrupted preview without changing pixels/history; its own engine limits still apply. These are robustness checks, not established equivalence. |
| Pending rectangle | Direct observation: release retains resize/rotation handles; palette changes recolor it, interior drag moves it, southeast resize keeps the opposite corner, and the rotation control rotates it. Enter retains editability. Escape removes it. Clicking outside the shape or canvas commits it, and one undo removes the entire transformed drawing. | 0.2.2 keeps ordinary shapes pending with live styling, movement, resizing and rotation; Enter retains editability. Escape cancels, outside clicks or tool changes commit. Regression tests cover those transitions and document pixels/history. Exact handle appearance, modifier behavior and all shape variants are not established as identical. |
| Interrupted drawing | Source audit found that cancellation could leave pending curves/polygons detached from their transaction and that history commands could leave stale brush canvases. | Shared gesture cleanup now clears transient geometry and pointer ownership together with the transaction. Exact Paint keyboard-interruption semantics remain unverified. |

The native automation API performs a drag atomically. Attempts to snapshot an in-flight drag returned settled frames, so this pass does not claim an independently captured Microsoft Paint mid-drag frame. The resize feedback requirement is grounded in the owner's report; automated intermediate-state assertions run against SJ Paint.

## Implemented features

- Dark and light layouts, palette and custom colors, tool sizes, opacity, zoom, grid, rulers, full screen, collapsible toolbar and layers panel.
- Pencil, brush, eraser, calligraphy variants, airbrush, oil, crayon, marker, natural pencil and watercolor.
- 23 shapes, two-control-point curves, polygon construction, outline/fill styles, constrained shapes and lines.
- Fill tolerance, color picker and multiline text with font, size, bold, italic, underline, alignment and background controls.
- Rectangular and free-form selections, inverse selection, color-key transparency for new selections, color inversion, move/resize/crop, copy/cut/paste, image rotation, flips, resize/skew and canvas dimensions.
- Layer add/delete/duplicate/reorder/rename, opacity, visibility, merge and transparent background.
- Undo/redo with saved-state identity, editable `.sjpaint` projects, legacy `.linuxpaint` project import, native file dialogs, image export and print integration.
- PNG, JPEG, WebP, BMP, GIF and TIFF export. PNG/JPEG/WebP/BMP/GIF import uses Chromium decoding. GIF is a single frame; TIFF import is absent.

## Baseline gaps and unresolved behavior

| Area | Current behavior |
| --- | --- |
| Microsoft services and AI | No Microsoft account, sharing or cloud integration. Cocreator, Image Creator, generative fill/erase, object selection and AI background removal are not implemented. |
| Project formats | `.sjpaint` stores SJ Paint's editable layers. Legacy `.linuxpaint` projects can be opened. Microsoft `.paint` files are not supported. |
| Drawing behavior | Brush rasterization, textures, selection and transform edge cases, text metrics and all command shortcuts are not proven identical to the reference. |
| Visual fidelity | Icons are newly drawn and rendering is independently implemented. Fonts depend on the host platform. Pixel-perfect layout and control behavior have not been established. |
| Advanced editing | Ordinary shapes remain editable with a free-rotation handle until committed. Committed text and shapes become pixels. Post-commit vector/text re-editing is not implemented. Curve/polygon editing still uses its earlier construction workflow. |
| Image formats | GIF has a fixed palette, binary transparency and one frame. TIFF export is uncompressed RGBA; TIFF import is absent. Full metadata preservation and color-managed workflows are not established. |
| Platform integration | The Linux installer passed GIO menu registration, eligibility and fixture-launch checks. Actual menu presentation in each desktop shell remains unverified. Physical printing, native chooser interaction, Wayland, complete accessibility support and ARM compatibility also remain unverified. |
| Resource limits | The editor enforces its own document, history and encoded-file bounds. Their equivalence to Microsoft Paint limits is unknown. |

Implemented controls and passing checks do not close these gaps. Baseline acceptance still requires reference-based verification of appearance and behavior, including features that are missing or currently uncertain. Project-specific feature development follows the completed baseline.

## Verification history

### Version 0.2.1 canvas resizing and interruption recovery

The headless browser suite passed 114 checks. The actual packaged Windows app passed 51 checks in a hidden window, preserving the user's clipboard. The Linux package passed 48 checks in an isolated Ubuntu 22.04 Xvfb container, including its private clipboard. Four atomic-save tests also passed. Native chooser responses remained harness-controlled.

Shared pointer tests inspect the resize preview and dimensions before release at 50%, 100% and 200% zoom, then verify growth, shrinkage, anchoring, cancellation, no-op history and undo/redo. Engine tests cover layered pixels, floating selections and allocation failure. Additional browser checks cover interrupted drawing, stale transactions and pointer ownership. The reference evidence and unknowns are listed above; these checks do not establish exact Paint rendering or unobserved command behavior.

### Version 0.2.0 Linux and desktop registration

The packaged Linux app passed 23 real runtime checks under Ubuntu 22.04 Xvfb, including native file operations, legacy project migration, all six exports and isolated clipboard use. The per-user installer passed 47 separate checks using a harmless executable fixture with the real launcher and SVG. GIO parsed the desktop file, discovered its application ID, reported it eligible for display and launched the fixture. Special-character paths, retained backups and refusal of unowned destinations were exercised. This establishes installer behavior without claiming a real GNOME/KDE app-drawer visual test.

### Version 0.2.0 Windows and browser checks

An initial run of the actual packaged Windows x64 app passed 24 checks. The test window was confirmed hidden at the start and end. Native `.sjpaint` saving, legacy `.linuxpaint` migration and reopening retained the image pixels. PNG, JPEG, WebP, BMP, GIF and TIFF export passed, along with PNG reopening.

The harness supplied native chooser responses while the real preload IPC, codecs and filesystem operations ran. The local Windows clipboard check was intentionally skipped. This does not establish visible-window behavior, interactive native dialogs, clipboard behavior on Windows or physical printing.

The headless browser suite passed 35 checks, and all four atomic-save filesystem checks passed. Local results are recorded in `output/verification.json` and `output/win32-verification.json`. The README screenshot comes from the Windows app runtime.

The Windows run after ownership and cleanup hardening passed 26 checks and confirmed application shutdown. The local Windows clipboard check remained skipped. These completed checks do not establish the full Microsoft Paint baseline.

### Version 0.1.0 Linux baseline

The earlier Paint for Linux release was exercised with headless Chrome UI and canvas workflows and as a packaged x64 Electron app under Ubuntu 22.04 Xvfb. The Linux checks covered drawing, undo/redo, layers, text, native project save/reopen, clipboard, PNG reopen and PNG/JPEG/WebP/BMP/GIF/TIFF export.

File chooser responses were supplied by the harness, while the real preload IPC, encoding, filesystem operations and decoding ran. Atomic-save filesystem checks also ran on Linux. This establishes a Linux baseline for that release, not verification of every platform or later release.

Local results were written to `output/verification.json` and `output/linux-verification.json`. These generated files are not committed. A successful build or container check does not establish physical printing, real desktop integration or compatibility on every machine.
