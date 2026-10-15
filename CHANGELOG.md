# Changelog

Changes are grouped by version. New headings created by the version helper remain unreleased until publication.

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
