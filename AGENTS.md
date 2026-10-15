# Working on Stack Junkie Paint

## Scope and authority

- Follow the user's current request and work from the current checkout. Preserve unrelated edits and active processes.
- Keep this repository independent of surrounding checkouts and machine-specific setup.
- Treat Windows as the primary desktop platform and preserve Linux and browser support. The baseline goal remains a 1:1 recreation of Microsoft Paint in appearance, features and behavior. The rebrand does not reduce that scope. Add project-specific features only after the baseline is completed and verified, unless the user explicitly changes that order.
- Do not publish, push, create releases, install system software or change user settings without authorization.
- Do not open visible apps, move focus or use the user's active desktop/browser without explicit authorization. Use headless browser tests and disposable Xvfb containers for authorized background verification.
- Write plainly. Never use em dashes. Do not claim completed Microsoft Paint parity, platform coverage or runtime verification without evidence.

## Implementation

- The document engine owns editing semantics, document limits, undo/redo and saved-state identity. Reuse its shared limits instead of adding conflicting checks in consumers.
- Preserve transparent pixels, layer order, visibility, opacity, selections and document state across file and editing operations. Decode and validate a replacement document before changing the current one.
- Save new layered documents as `.sjpaint` and preserve the ability to open legacy `.linuxpaint` projects. Microsoft `.paint` compatibility is not implied by either format.
- Keep Electron `contextIsolation` and `sandbox` enabled and `nodeIntegration` disabled. Native IPC must validate the sender and request bounds. Do not expose arbitrary paths or Node.js to the renderer.
- Use the atomic-write helper for native saves. Clean up only resources the operation owns, and preserve ownership details when cleanup fails.
- Fix the source of duplicated interpretation or inconsistent ownership when touching related code. Avoid wrappers and test-only behavior that hide the failure.
- Do not bundle Microsoft binaries, icons, model weights or private sample files. Keep provenance, feature boundaries and verification history current in `PARITY.md` and `ATTRIBUTION.md`.

## Checks and delivery

- Use the Node.js version in `.nvmrc` and install locked dependencies with `npm ci`. Install the local Git hooks with `npm run hooks:install` when requested as part of setup.
- Use `npm run version:check`, `npm run test:files`, `npm test` and `npm run build` as appropriate to the change. `npm test` is headless; `PAINT_CHROME_PATH` selects an installed Chromium executable.
- Use `npm run test:windows` for authorized background checks of the packaged Windows app. It owns a hidden process and temporary profile. Preserve the default clipboard skip unless clipboard changes are authorized in an isolated environment.
- `npm run test:linux` requires the isolated harness described in `CONTRIBUTING.md`. Never attach it to an unrelated desktop session or expose its inspector ports beyond loopback.
- Report checks actually executed and their limits. A build, simulated chooser or container test does not establish physical printing, native chooser interaction, Wayland, ARM or complete accessibility coverage.
- Use Conventional Commit subjects and PR titles. Group runtime changes into coherent commits; the pre-commit hook requires a version increase and descriptive changelog entry for commits changing `src/` or `electron/`. The canonical version is in `src/version.js`; use the version scripts to keep related files aligned. Documentation-only commits do not need a version bump.
- Do not commit generated builds, dependencies, test output, release archives, local configuration or credentials. Review the final diff and keep PR descriptions focused on the problem, changed behavior and validation.
