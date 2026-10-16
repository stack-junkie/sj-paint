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
| Selection cancellation and history | Direct observation: after moving and releasing a rectangular selection, Escape restores the original position and removes handles. Undo also restores the original; Redo restores moved pixels without handles. Undo of an unchanged selection only removes handles. Enter retains selection handles. | 0.2.3 keeps selection edits in one cancellable session. Browser tests exercise these transitions, existing redo preservation, one-step commitment and thin selections. Clipboard race and failed-command rollback checks establish robustness, not observed Paint equivalence. |
| Selection free rotation | Direct observation: the rotation handle rotates selected pixels and their control frame; Escape restores the original orientation and drops handles. The displayed selection dimensions retain the frame size while rotated. | 0.2.4 adds an oriented selection frame and rotation control. Geometry edits retain source pixels and masks until accepted. Exact rasterization, modifiers and handle appearance remain unverified against Paint. |
| Rotated selection crop | Direct observation: Crop uses the rotated frame's axis-aligned bounds across layers, preserving lower-layer orientation. First Undo restores the full canvas with committed rotated pixels; second Undo restores the original placement. | 0.2.4 records accepted placement and Crop separately. Regression coverage checks layer coordinates, cancellation and rollback if cropping fails. |
| Square eraser and color replacement | Native 8-pixel horizontal and diagonal erasures have binary square-sweep coverage. Right-button erasing replaces Color 1 with Color 2 while retaining alpha; a 64-cell grid around red matches squared RGB distance at most six. | 0.2.6 uses a dedicated square eraser and shared cursor footprint, independent of brush opacity. Captured opaque pixel results match exactly; partial-alpha comparisons use premultiplied bytes. Other primary colors, odd sizes and fractional snapping remain unverified against Paint. |
| Interrupted drawing | Source audit found that cancellation could leave pending curves/polygons detached from their transaction and that history commands could leave stale brush canvases. | Shared gesture cleanup now clears transient geometry and pointer ownership together with the transaction. Exact Paint keyboard-interruption semantics remain unverified. |

The native automation API performs a drag atomically. Attempts to snapshot an in-flight drag returned settled frames, so this pass does not claim an independently captured Microsoft Paint mid-drag frame. The resize feedback requirement is grounded in the owner's report; automated intermediate-state assertions run against SJ Paint.

## Implemented features

- Dark and light layouts, palette and custom colors, tool sizes, opacity, zoom, grid, rulers, full screen, collapsible toolbar and layers panel.
- Pencil, brush, eraser, calligraphy variants, airbrush, oil, crayon, marker, natural pencil and watercolor.
- 23 shapes, two-control-point curves, polygon construction, outline/fill styles, constrained shapes and lines.
- Fill tolerance, color picker and multiline text with font, size, bold, italic, underline, strikethrough, alignment and background controls.
- Rectangular and free-form selections, inverse selection, color-key transparency for new selections, color inversion, move/resize/crop, copy/cut/paste, image rotation, flips, resize/skew and canvas dimensions.
- Layer add/delete/duplicate/reorder/rename, opacity, visibility, merge and transparent background.
- Undo/redo with saved-state identity, editable `.sjpaint` projects, legacy `.linuxpaint` project import, native file dialogs, image export and print integration.
- PNG, JPEG, WebP, BMP, GIF and TIFF export. PNG/JPEG/WebP/BMP/GIF import uses Chromium decoding. GIF is a single frame; classic TIFF import supports RGB/RGBA8 strips with uncompressed, PackBits, LZW and Deflate data.

## Baseline gaps and unresolved behavior

Microsoft documents a mixture of device-specific local models and account-backed cloud services for Paint AI. Cocreator, Image Creator, generative fill, object select and sticker generation have separate requirements. No equivalent backend has been selected or connected for SJ Paint, and matching their output is not established. See [Microsoft Paint application card](https://learn.microsoft.com/en-us/windows/ai/cards/microsoft-paint-application-card) and [Copilot+ Paint requirements](https://support.microsoft.com/en-us/windows/ai/ai-apps/use-copilot-pc-features-in-paint), checked 2026-10-15. This documentation is capability context, not a runtime observation of the pinned reference build.

| Area | Current behavior |
| --- | --- |
| Microsoft services and AI | No Microsoft account, sharing or cloud integration. Cocreator, Image Creator, generative fill/erase, object selection and AI background removal are not implemented. |
| Project formats | `.sjpaint` preserves all local layer state and legacy `.linuxpaint` remains readable. `.paint` support covers the observed full-canvas BGRA8/raw-DEFLATE layers and overlay background. Hidden-layer or layer-opacity export is rejected; unknown properties, cropped/offset layers and other variants remain unsupported. Exif is accepted but discarded. |
| Drawing behavior | Brush rasterization, textures, selection and transform edge cases, text metrics and all command shortcuts are not proven identical to the reference. |
| Visual fidelity | Icons are newly drawn and rendering is independently implemented. Fonts depend on the host platform. Pixel-perfect layout and control behavior have not been established. |
| Advanced editing | Ordinary shapes remain editable with a free-rotation handle until committed. Committed text and shapes become pixels. Post-commit vector/text re-editing is not implemented. Curve/polygon editing still uses its earlier construction workflow. |
| Image formats | GIF has a fixed palette, binary transparency and one frame. TIFF export uses LZW/predictor-2 RGBA. TIFF import covers classic RGB/RGBA8 strips and orientations 1 through 8; multipage, tiled, planar, palette/grayscale, higher bit depth and color-profile variants are rejected. Full metadata preservation and color-managed workflows are not established. |
| Platform integration | The Linux installer passed GIO menu registration, eligibility and fixture-launch checks. Actual menu presentation in each desktop shell remains unverified. Physical printing, native chooser interaction, Wayland, complete accessibility support and ARM compatibility also remain unverified. |
| Resource limits | The editor enforces its own document, history and encoded-file bounds. Their equivalence to Microsoft Paint limits is unknown. |

Implemented controls and passing checks do not close these gaps. Baseline acceptance still requires reference-based verification of appearance and behavior, including features that are missing or currently uncertain. Project-specific feature development follows the completed baseline.

## Verification history

### Version 0.2.13 curve construction, text focus and TIFF export

Headless pointer reproduction found that an initial diagonal curve changed 4,689 RGBA channel values on release. Holding Shift changed 6,507 values and discarded the constrained endpoint. One curve geometry owner now creates the initial straight segment and carries its constrained endpoint into control-point editing. The public browser and desktop helper entrypoints passed 44 checks in headless Chrome, including cancellation, history and layered previews. This is source-runtime verification, not new native Paint observation.

Text reproduction also found that the browser's default pointer action focused the canvas after creating a text box. After explicitly focusing and typing a draft, clicking Bold then typing P committed the draft and selected Pencil. Text creation now prevents that default focus action. Pointer formatting captures and restores the same text session's selection; keyboard navigation retains toolbar focus. Nineteen focused public-control checks passed, including colors, keyboard Redo and one-step text history. The complete source browser suite passed 678 checks, the TIFF codec passed 24 groups, and seven native filesystem tests passed. The Windows package built successfully; packaged verification remains pending.

TIFF encoding now shares the decoder module and writes bounded row-aligned LZW/predictor-2 strips. Eighty-two independently decoded files matched exact RGBA hashes in Pillow 12.3.0/libtiff 4.7.1. Explicit uncompressed encoding remains byte-compatible with the old exporter. The actual save path uses the same encoder cooperatively; a 2-megapixel noisy input produced identical 11,477,856-byte output, while event-loop heartbeats progressed during encoding. One shared-host measurement reduced the longest heartbeat gap from 923 ms to 29 ms; total encode time increased from 923 ms to 1,218 ms. Snapshot readback, final allocation, Blob conversion and native IPC still have synchronous work. Noise can expand under LZW. CPU samples are coarse; process-family peak memory, agent token cost and native reopening of these new exports are unmeasured. Measurements and independent evidence are retained under local output/tiff-export-evidence.

Full Paint parity remains open. Local-first AI evaluation was selected, with acquisition approval still required. Background reference isolation probes have not established safe Paint activation; no reference process was launched. Existing references continue to support independently useful fixes.

### Version 0.2.12 draft state, Fit and remaining decoded shortcuts

The selected resource audit now decodes all 84 streams in ten XBF files. Explicit consumers establish Ctrl+Shift+N for a layer above the active layer, Ctrl+R for rulers, Ctrl+G for gridlines, Ctrl+T for ribbon visibility, and Ctrl+0 for 100% zoom. Tool consumers use B/T/I/Z/P/E/S for fill/text/picker/magnifier/pencil/eraser/selection. Their omitted modifier property is interpreted using Microsoft's documented [None default](https://learn.microsoft.com/en-us/windows/apps/develop/input/keyboard-accelerators). These are resource and framework-derived bindings; native focus rules and runtime overrides remain unobserved.

SJ Paint routes those shortcuts to its existing commands. Ctrl+Shift+N no longer falls through to New. Source inspection also found that unfinished curves and polygons were absent from the toolbar Undo and dirty-state checks. The UI now uses the same pending-drawing state as unload protection, and text input invalidates that display immediately. These are internal correctness fixes, not native behavior measurements.

The final decoded-consumer reconciliation leaves Ctrl+B/Ctrl+I/Ctrl+U on the native text toolbar unresolved. Their key/modifier pairs are explicit, but activation and focus precedence need observation before changing SJ Paint's global behavior, particularly Ctrl+I's image command. Ribbon Escape scope, four consumers with no serialized key, and brush-size constants without decoded consumers also remain unknown. Exact brush/text rasterization, selection modifiers and control-point keyboard behavior still require reference interaction evidence. The owner's background-only restriction remains in force.

The packaged Linux shortcut check exposed inconsistent Fit results when entering from different zoom levels. Fit now measures the viewport's stable layout dimensions and subtracts its actual responsive padding and borders, rather than reusing the previous zoom's scrollbar-reduced client dimensions. Twelve focused headless checks cover wide/narrow layouts, tall/wide drawings and both zoom directions. Twelve draft checks and 45 additional shortcut checks passed. The complete local browser suite passed 637 checks, and the 43 new public-control package checks passed in headless Chrome. Final CI passed 189 Windows package checks, 184 Linux package checks and 47 Linux installer checks. A corrected local Windows save/close rerun passed 33 checks and exited cleanly. Seven native file-target/atomic-write tests passed. Native chooser responses remained harness-controlled; the local clipboard was untouched.

Windows 0.2.10 completed 146 app checks, but its harness failed during cleanup because the app's successful Close had already stopped the inspector. The corrected harness retains the launch-owned exit promise across every transport stage; an unavailable inspector alone never establishes cleanup authority. Versions 0.2.10 and 0.2.11 were consolidated into the published 0.2.12 release rather than released separately. The final test source waits for the stroke release frame before capturing Undo/Redo or close-save pixel expectations. The complete Windows/Linux CI run 38855013801 passed at source 4df1dee823f8adfa06a22cb19cbe8a1bfce7fa9c. Public asset digests and the source tag were verified.

### Version 0.2.11 resource-backed shortcuts

Bounded XBF 2.1 decoding following [Microsoft's XBF parser](https://github.com/microsoft/microsoft-ui-xaml/tree/main/dxaml/xcp/tools/XbfParser/WidgetSpinner) recovered typed key/modifier constants and their consuming `KeyboardAccelerator` properties. The pinned `VirtualKeyResources.xbf` SHA-256 is `a65404675520968e6ea92bd0e4a1e280aee8abc60d64e3608b3b9abad2e18d6f`. Both PRI copies contain identical bytes. Explicit consumers in LayersPanel, ImageToolbar and ZoomSlider establish these combinations:

| Command | Shortcut |
| --- | --- |
| Current-layer visibility | Ctrl+H |
| Move current layer up/down | Ctrl+Shift+PageUp/PageDown |
| Delete current layer | Ctrl+Shift+Delete |
| Crop | Ctrl+Shift+X |
| Fit | Ctrl+1, including numeric keypad 1 |
| Zoom in/out | Ctrl+PageUp/PageDown |

SJ Paint now routes those keys to its existing editing commands. Text fields and open dialogs retain their keys. Extra Alt modifiers cannot fall through to Cut or another document command, and keypad navigation End is distinct from numeric keypad 1. The complete browser suite passed 565 checks before the final modifier guard; focused checks cover that guard and keypad events. The public-control desktop helper passed ten checks in a headless browser; packaged checks are pending. Stored bindings establish command/key relationships, not native focus scope, zoom increments or runtime overrides. Other XBF streams that stop at unsupported custom data remain unparsed; their resource names alone are not treated as verified bindings.

### Version 0.2.10 save decisions and editing controls

Read-only Windows SDK `makepri dump` inspection of the installed 11.2605.81.0 package confirms Save/Don't save/Cancel resources, a warning about flattened layer exports, Strikethrough text controls, and control-point help advertising Ctrl+Space to commit. The package `resources.pri` SHA-256 is `07966dd87cc747e8d17c7a68bc607448672183cc1c85d0acb01bd16248ce7ae5`. REA established the executable/resource inventory; the SDK decoded PRI resources. No native window activation was used for this inspection, and Microsoft resource dumps are not distributed here.

SJ Paint implements those capabilities. New, Open and desktop close keep the drawing after canceled or failed saves or intervening edits. Native close uses a window-owned request and the renderer's document identity check, without bypassing its unload veto. Reload cannot become a close request. Dialog invocations own their results so an earlier queued close event cannot resolve a replacement dialog. Strikethrough shares the existing text edit and history. Ctrl+Space commits pending selections and ordinary shapes from their canvas controls while leaving text input alone.

A headless pointer regression exposed different antialiasing between a pending shape and its accepted layer: 2,397 channel values differed, by up to 48. Initializing both layer and scratch contexts with the engine's existing readback setting eliminated that difference in the captured case. This corrects SJ Paint's internal preview consistency; it is not evidence of Microsoft raster equivalence. Exact native dialog appearance, strikethrough metrics and control-point focus rules remain unverified. The complete browser suite passed 551 checks; seven native file-target/atomic-write tests passed with normal filesystem permissions. Packaged checks are pending. Rendering throughput and process memory changes have not been benchmarked.

### Version 0.2.9 desktop save identity

Source inspection and a failing headless reproduction found that every desktop Save reopened the chooser and discarded the actual chosen filename. Open and successful saves now retain an opaque native destination, bound to the current document generation and encoded format. Save As selects a new destination; cancellation and late completion after document replacement preserve the current identity. TIFF content under a mismatched extension does not reuse an incompatible destination. Save shortcuts also work while typing text or editing a numeric control.

The browser suite passed 514 checks and seven native file-target/atomic-write tests passed. The hidden Windows package passed 139 checks, the isolated Linux CI package passed 134, and Linux app-drawer installation passed 47. [CI 38849766386](https://github.com/stack-junkie/sj-paint/actions/runs/38849766386) passed on Windows and Linux. Both published archives contain the verified app.asar. These are source-derived file workflow corrections, not a claim that all native save dialogs or Microsoft Paint file semantics have been compared.

### Version 0.2.8 pending drawing ownership and compositing

The local browser suite passed 503 checks, hidden Windows passed 138 and the isolated Ubuntu CI runner passed 133 packaged-app checks. The local Windows clipboard was untouched; CI used its disposable clipboard. Private native-reference fixtures are omitted from CI. The added cases compare actual display canvas and overlay pixels while a pointer is held, after release and after acceptance. Rectangles, curves and polygons apply active-layer opacity once and remain behind foreground layers. Existing layer pixels and history stay unchanged until acceptance; cancellation removes the preview. The shared compositor reuses its existing scratch canvas. Large-document latency and peak process-family memory have not been measured.

The desktop test waits for release handles separately from held shape pixels. A Fit-to-window test failure at a 1024-pixel viewport was reproduced as a 0.01215 CSS-pixel layout rounding difference; the geometry wait now permits one Chromium layout unit (1/64 CSS pixel). Seven focused text checks and the following brush stroke passed at that viewport. This tolerance applies to CSS geometry readiness, not document pixel comparisons.

Pan tests preserve pending text, ordinary shapes, curves, polygons and selections through Escape, pointer cancellation, capture loss, blur and normal release. Continued editing remains one undoable operation. Fill, Text and Polygon now share the existing hidden-layer admission policy. These source-derived correctness fixes do not establish unobserved Microsoft Paint behavior. The disposable native Paint window was later observed minimized. Further foreground comparison is deferred under the owner's background-only instruction; the user's separate document has been preserved.

### Version 0.2.7 TIFF, text and keyboard controls

The browser suite passed 443 checks, hidden Windows passed 124, isolated Linux passed 120, and 16 TIFF codec groups passed locally. Four atomic-save tests passed.

Two owned Paint TIFF saves establish native LZW/predictor-2 RGBA8 compatibility: an opaque 128 by 128 color grid (1334 bytes, SHA-256 `e9dea64dc8bc57c6d134256a3b63cb7f1bb97133be874d3c7b10f6a8008999d5`) and a partially transparent 200 by 100 sample (956 bytes, SHA-256 `cdaddd4653fe257673a040780b40232945724326cb09546d953ea1426cb4ed45`). Decoded bytes match the corresponding native .paint and PNG pixels exactly. Synthetic codec cases also exercise both byte orders, strip codecs, predictor, orientation, alpha and malformed inputs. Imported metadata is not retained.

Text checks cover long-word wrapping, leading spaces, alignment and browser-measured baselines. Native observation confirmed a live text draft with leading spaces and wrapped long words, and Edit colors opening above the draft controls. The reference window stopped responding during Cancel, so its cancel outcome is unknown. SJ Paint checks establish draft/transaction preservation through that dialog and focused-button Redo. Exact native text-box transforms, opaque background extent, typography and all editing shortcuts remain unresolved.

Keyboard checks cover Enter activation, menu dismissal, focus restoration and surviving layer controls through visibility changes and reorder Undo. These are verified SJ Paint robustness fixes; they do not establish complete native keyboard or assistive-technology parity.

### Version 0.2.6 eraser reference coverage

The browser suite passed 366 checks, the hidden Windows package passed 96, and the isolated Linux package passed 92. Four atomic-save tests passed. The packages exercise erasing, color replacement, cancellation and history through public controls. Browser tests additionally cover cursor alignment at multiple zoom levels and after stationary-pointer scrolling. Windows clipboard remains untouched.

The reference horizontal/diagonal fixture uses an 800 by 400 canvas with a yellow lower layer and red, green, white and black bands above. An 8-pixel erasure clears alpha on the upper layer only. A right-button click replaces red with turquoise and leaves green unchanged. The diagonal produces 3256 newly cleared pixels, exactly matching continuous square coverage at pixel centers. Separate alpha-64, alpha-128 and opaque samples preserve alpha during replacement.

The fine color fixture contains 64 cells around RGB (237,28,36). All cells agree with a squared RGB distance threshold of six, including combined channel differences. This rule is inferred from that measured grid; it has not been sampled across every primary color. Native fixtures remain local test evidence and are not distributed. The browser suite includes optional digest-pinned comparisons when those files are available, plus synthetic cases on every run. Cursor, interruption and history checks establish SJ Paint behavior where equivalent reference observations are still absent.

### Native .paint reference evidence

Two disposable files saved by Paint 11.2605.81.0 establish the supported variant: one layer (2545 bytes, SHA-256 `011068fb966e10b80a30b822bcaddf9966c82360143bdb215417d86806168e4e`) and two layers (4691 bytes, SHA-256 `ca6f3de4933a8f27c63001e33af5ba8648e279bf402f290e26e3d0fca67bb666`). Both use an 813 × 431 canvas. The codec decoded both, then wrote a 4581-byte two-layer file. Actual Paint opened it with both editable layers and resaved a byte-identical copy of the original two-layer file. This is native interoperability evidence for those samples; layer names in them were empty.

A separate transparent sample with a partially transparent rectangle opened correctly in Paint. Its native PNG export changed center RGB from (180,80,40) to (179,79,39), retaining alpha 128. Canvas-based import tests therefore declare a one-unit partial-alpha RGB tolerance; opaque pixels and alpha are checked exactly. Layer background bytes are preserved directly, without canvas rounding. Saving the reference with one layer hidden produced a byte-identical file, so hidden-layer persistence is not established and is not claimed.

### Version 0.2.5 native project support

The browser suite passed 304 checks. New cases exercise native project Open, Open project, drag and drop, Save As and Ctrl+S, plus malformed files, unsupported exports and atomic document replacement. Deferred file operations preserve newer drawing edits, unfinished text and replacement-document identity. Saving a native project as PNG switches subsequent Ctrl+S to PNG while retaining its editable layers in memory. The codec suite passed 18 groups locally, including two owned native fixtures; CI omits those ignored binary fixtures and runs the synthetic groups.

The final packaged Windows app passed 89 checks with its window hidden and clipboard untouched. Isolated Linux passed 86, including its private clipboard. Four atomic-save tests passed. Both packages exercise native project binary IPC, real filesystem round trips, unsupported-export preservation and PNG format continuity. Chooser responses remain harness-controlled.

Native Paint also showed a flattening warning before PNG Save As, then retained its editable layers with the PNG filename. SJ Paint now matches that next-save format behavior, but the exact warning interaction remains unresolved.

### Version 0.2.4 selection transforms

The browser suite passed 267 checks. New cases cover source-preserving affine transforms, inverse rotation, anchored resizing, transformed Cut output, rotation-control edges and placement outside the canvas, cancellation, and separate placement/crop undo steps. Geometry comparisons allow 0.00001 document pixels for floating-point arithmetic. Preview, commit and crop pixels compare exactly within SJ Paint, including lower-layer composition; this does not establish pixel-exact Microsoft Paint rasterization.

The packaged Windows app passed 76 checks in its hidden window with the clipboard untouched. Isolated Linux passed 73 checks, including its private clipboard. Both exercise rotation and its cancellation/history through public controls. Four atomic-save tests passed. Chooser responses remain harness-controlled; modifier behavior, crossing resize edges, complete keyboard accessibility and exact control appearance remain unverified.

### Version 0.2.3 selection sessions

The browser suite passed 213 checks. Selection session tests cover cancellation, saved-state identity, commitment, undo/redo, crop/delete, layer changes, failed allocation and asynchronous clipboard target changes. Clipboard races use deferred browser adapters and do not touch the operating-system clipboard. The packaged Windows app passed 68 checks with its window hidden and clipboard untouched; isolated Linux passed 65, including its private clipboard. Both packages exercise selection move/resize cancellation and undo/redo through public controls. Four atomic-save tests passed. Large-document latency and peak process memory have not been measured; retained history and temporary snapshots have separate bounded ownership.

### Version 0.2.2 pending ordinary shapes

The browser suite passed 160 checks, including 14 geometry groups, nine layer-preview groups and public UI shape workflows. Geometry comparisons tolerate only 0.00001 document pixels for DOMMatrix arithmetic; preview and committed display pixels compare exactly. The packaged Windows app passed 59 checks with its window hidden and clipboard untouched. The isolated Linux package passed 56 checks, including its private clipboard. Four atomic-save tests passed.

The package checks exercise pending release, recoloring, Enter retention, movement, Escape and a committed drawing's single undo step. Browser tests additionally cover rotation, anchored resize, output settlement and interruption ownership. Browser clipboard and print settlement checks use stubbed output adapters, not actual native printing. The native chooser remains harness-controlled. Unobserved Paint behavior remains explicitly open above.

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
