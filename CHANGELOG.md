# Changelog

Changes are grouped by version. New headings created by the version helper remain unreleased until publication.

## [0.2.15] - Unreleased

- Cancel the browser default for a middle-button pan release, including release after cancellation or outside the canvas, so Linux selection-paste cannot overwrite a live text selection.

- Keep the displayed font size consistent with the accepted rendering value, including clamped and fractional input. Add resource-backed size presets, three alignment buttons and the Background fill label while preserving draft selection and keyboard focus.
- Import packed 1/2/4-bit grayscale and palette TIFF strips through the shared decoder, with padded-row bounds, explicit predictor limits and independent fixture validation.

## [0.2.14] - Included in 0.2.15

- Preserve custom-palette button identity and keyboard focus across color activation, dialogs and drawing previews. Expose text-formatting pressed states to assistive technology.
- Keep text selection and deliberate toolbar focus during viewport panning, including release and cancellation, so continued typing stays in the draft.
- Align tool-button and icon dimensions, text-control spacing and status metric text with decoded Paint resource definitions, retaining independently drawn artwork.
- Open 8-bit grayscale and palette TIFF images through the existing validated strip decoder, including supported compression, horizontal prediction and all eight orientations. Reject malformed palettes and unsupported channel variants before replacing the drawing.

## [0.2.13] - 2026-10-16

- Keep the initial curve segment straight and preserve Shift-constrained endpoints when the pointer is released and control-point editing begins.
- Focus newly created text immediately and preserve the text selection after pointer-operated formatting, palette and color-dialog actions, while retaining deliberate keyboard toolbar focus.
- Save TIFF with lossless LZW compression and horizontal prediction, preserving alpha and yielding between bounded strips so encoding does not monopolize the UI thread.

## [0.2.12] - 2026-10-15

- Enable Undo and show unsaved work for unfinished curves and polygons using the same pending-drawing state as close protection.
- Make Fit independent of scrollbars left by the previous zoom level.
- Match decoded Paint layer creation, ruler/grid/ribbon, 100% zoom and tool-selection shortcuts, preserving input and dialog ownership.
- Let the Windows verifier recognize its owned app's normal exit when Close has already stopped the inspector.

## [0.2.11] - Included in 0.2.12

- Match decoded Paint shortcuts for active-layer visibility (Ctrl+H), layer movement (Ctrl+Shift+PageUp/PageDown), layer deletion (Ctrl+Shift+Delete), crop (Ctrl+Shift+X), fit (Ctrl+1), and zoom (Ctrl+PageUp/PageDown).
- Preserve text-field and modal ownership of keyboard input; crop uses the document operation without touching the clipboard.
- Ignore extra Alt modifiers instead of falling through to Cut or other document commands; distinguish numeric keypad 1 from keypad navigation End.

## [0.2.10] - Included in 0.2.12

- Offer Save, Don't save and Cancel before New, Open or desktop close. Canceled or failed saves and intervening drawing edits retain the current document.
- Confirm exports that flatten editable layer state, retain the current format in Save As, and keep replacement dialogs from consuming earlier dialog events.
- Add strikethrough for live and committed text, including combined underline and strikethrough.
- Support Ctrl+Space to commit a pending selection or ordinary shape from the canvas controls.
- Initialize document layers and preview scratch surfaces consistently so shape commitment preserves preview edge pixels.
- Keep dirty reloads from being mistaken for window-close requests.

## [0.2.9] - 2026-10-15

- Save desktop documents back to their opened or last saved file without reopening the chooser, including files named Untitled.
- Adopt the actual filename chosen in Save As, retain the previous destination after cancellation, and prevent new documents from inheriting old save destinations.
- Honor Ctrl+S and Ctrl+Shift+S while typing text or editing a numeric control, while preserving local text-editing shortcuts.
- Keep destination paths in the native process behind bounded, format-specific handles; format changes and mismatched file signatures require a new destination.

## [0.2.8] - 2026-10-15

- Preserve pending text, shapes, curves, polygons and selections when panning ends or is canceled, including interrupted pointer capture and window blur.
- Composite held shapes, curve controls and polygon previews within their active layer so opacity and foreground occlusion match accepted pixels.
- Apply the same hidden-layer drawing rule to Fill, Text and Polygon as the other drawing tools.

## [0.2.7] - Included in 0.2.8

- Import supported classic TIFF images through Open, drag and drop and Paste from file, including native Paint LZW/predictor samples and transparent pixels.
- Preserve text wrapping, long words and leading spaces when applying a draft, and keep its editing transaction intact through Redo and the color dialog.
- Let Enter activate focused controls, retain layer focus through updates and reordering, and dismiss menus without canceling artwork or stealing another control's keys.

## [0.2.6] - 2026-10-15

- Match observed square erasing, continuous diagonal coverage and right-button Color 1 to Color 2 replacement while preserving alpha.
- Give the eraser its own size and cursor footprint, independent of brush opacity, and cancel interrupted strokes without stale history.
- Keep the eraser cursor aligned during zoom and scrolling, and retain fractional zoom presets in the dropdown.

## [0.2.5] - 2026-10-15

- Open and save the observed Microsoft Paint .paint project variant, preserving layer order, names, pixel transparency and separate canvas background.
- Add .paint to Open, Open project, drag and drop, Save As and format-preserving Ctrl+S on Windows, Linux and browser builds.
- Reject unsupported project variants and exports with hidden layers or layer opacity before replacing documents or writing output; retain .sjpaint for those states.
- Bound format parsing and decompression, and cancel delayed opens if the current drawing changes.
- Preserve newer drawing and text edits during delayed file operations, and keep subsequent Ctrl+S in the chosen raster format after Save As.

## [0.2.4] - 2026-10-15

- Rotate raster selections freely with an editable frame and a rotation control, including above the canvas edge.
- Preserve original selection pixels and masks through move, resize, rotate and flip operations; render and copy the transformed result from one shared geometry model.
- Match the observed crop history: accept transformed placement first, then record the crop as a separate undoable edit.

## [0.2.3] - 2026-10-15

- Preserve the complete selection session so Escape restores original pixels after moving or resizing a released selection.
- Match selection Undo/Redo and Enter retention, and restore the pending session if another document operation fails.
- Accept one-pixel-wide and one-pixel-high selections while treating a click without movement as deselection.
- Bind delayed Cut, Paste and Paste from file operations to their original editing target, preserving newer content if the drawing changes while they wait.

## [0.2.2] - 2026-10-15

- Keep newly drawn ordinary shapes editable after release, with move, resize and rotation controls.
- Update pending shape colors, outline, fill, thickness and opacity live; commit one drawing when starting another operation, keep it editable on Enter, and cancel it with Escape.
- Preserve layer order and opacity in pending previews, and settle pending artwork before file, clipboard and layer operations.

## [0.2.1] - 2026-10-15

- Show a live outline and pixel dimensions while resizing the canvas, with eight edge and corner handles.
- Preserve opposite edges and translate existing layers when resizing from the top or left; commit one undoable change on release.
- Cancel interrupted gestures cleanly, preventing stale brush or pending geometry state from bypassing undo and unsaved-change tracking.
- Show selection dimensions during rectangle selection and test held-pointer feedback, cancellation, zoom and history through the real UI.

## [0.2.0] - 2026-10-15

- Rename the app to Stack Junkie Paint (SJ Paint), with Windows as the primary platform and Linux support retained.
- Add a portable Windows x64 package and real hidden-window Windows verification.
- Update the bundled Electron runtime to 44.7.2 to address published runtime security advisories.
- Add a per-user Linux installer, app-drawer launcher and original SJ Paint icons.
- Save layered projects as `.sjpaint` while retaining import of existing `.linuxpaint` files.
- Keep the full Microsoft Paint appearance, feature and behavior baseline explicit; project-specific additions follow parity.

## [0.1.0] - 2026-10-15

- Add a local browser and Electron drawing editor with brushes, shapes, text, layers, and bounded undo history.
- Add rectangular and free-form selections, color inversion, transparent selection, image transforms, and editable project files.
- Add image import and export, a Linux desktop package, and background verification scripts.
- Document the differences from Microsoft Paint and the limits of verification.
