# Contributing

Bug reports, small fixes and proposals are welcome. Stack Junkie Paint is an independent Windows/Linux desktop editor, with Windows as its primary platform. Releases cover supported painting, image-editing, file-format and AI workflows with documented compatibility limits. Exact Microsoft Paint parity, a separate browser product, Microsoft account and cloud-service replication, physical-printer certification and exhaustive hardware certification are outside the release requirements. Check the [coverage inventory](PARITY.md) before opening an issue. An incomplete diagnosis is fine; distinguish what you observed from what you suspect.

## Development

Use the Node.js version pinned in `.nvmrc` (24.14.0) and npm. From the repository root:

```sh
npm ci
npm run hooks:install
npm run dev
```

The shared editor uses Vite for browser development and headless tests. The desktop application loads the production build:

```sh
npm run build
npm run desktop
```

Keep changes focused and preserve unrelated work. The document engine owns editing semantics, history, saved-state identity and document resource limits. File code handles formats and transport; the Electron main process owns native filesystem access and dialogs. Keep Node.js access out of the renderer, preserve the sandbox and context isolation, and validate IPC senders and inputs.

Do not weaken atomic saves, cleanup ownership, cancellation, file-size limits or document-memory bounds to make a test pass. New formats and editing tools should produce real output and retain existing documents when an operation fails.

## Checks and pull requests

Run the checks relevant to the change. For changes to application behavior, the normal local checks are:

```sh
npm run version:check
npm run test:files
npm test
npm run build
```

The browser suite runs headlessly and uses installed Google Chrome by default. Set `PAINT_CHROME_PATH` to an installed Chromium executable if needed. It writes results under `output/`. The file suite uses temporary files and does not launch Electron's UI. Documentation-only changes need link and content review, not a full application test run.

For focused text checks, use `npm run test:text` or pass helper names after `--`, such as `npm run test:text -- text-session layer-keyboard canvas-resize-keyboard`. `npm run test:verification` checks result reporting and private-fixture resolution. Skipped cases carry their reason and never count as passes.

Private native fixtures are optional and must never be committed or redistributed. `SJ_PAINT_NATIVE_FIXTURE_DIR` can name an absolute read-only directory containing the recorded fixtures. The harness verifies pinned digests in place. An explicitly selected missing or changed fixture fails; absence from the optional default directory is a skip.

`npm run test:print-pdf` uses installed Chrome and an existing Python with PyMuPDF to independently rasterize tall/wide PDF output in both themes. `PAINT_PYTHON_PATH` selects that interpreter. Reports and PDFs go to `output/pdf/`. This does not exercise a physical printer or an interactive print chooser.

Keep reports precise: include commands that actually ran, their results, and coverage that was unavailable. A successful build does not prove editing behavior, desktop integration or full Microsoft Paint parity. Review AI-assisted changes yourself and describe any remaining uncertainty. Keep unfinished work in a draft PR.

Use Conventional Commit subjects and PR titles, such as `fix: preserve transparent project backgrounds` or `feat: add TIFF export`. Include a focused regression check when it demonstrates a real failure boundary. Avoid tests that merely restate the implementation.

Do not commit `node_modules/`, `dist/`, `release/`, `output/`, local settings, credentials or private drawings. Use small, shareable fixtures for reproductions. Packaged applications belong in GitHub Releases.

## Versions and releases

Group runtime changes into coherent commits. After the initial commit, the pre-commit hook requires a version increase and descriptive changelog entry for each commit that changes runtime files under `src/` or `electron/`. Uncommitted intermediate edits, tests, and documentation-only commits do not require a bump. The canonical application version lives in `src/version.js`; `npm run version:check` verifies the related metadata. Run `npm run version:bump -- <semver>` before committing a runtime change and add its release notes to `CHANGELOG.md`. The helper synchronizes the package metadata and README download references.

Release notes should describe observable changes and relevant validation. Do not claim platform support or runtime verification that has not been demonstrated. Publication and release creation require maintainer authorization.

On Windows, run `npm run package:windows` followed by `npm run archive:windows` to create the portable ZIP and checksum under `release/`. On Linux, use `npm run package:linux` followed by `npm run archive:linux` for the portable tar archive. Archive commands require the matching unpacked package and include documentation and license notices.

## Hidden Windows verification

After `npm run package:windows`, run `npm run test:windows` to exercise the packaged app in an owned, hidden window with a temporary profile. The harness refuses occupied test ports 9229 and 9231, then runs the desktop checks against its own process. It writes `output/win32-verification.json`, `output/desktop-verification.json` and `output/windows-launch.log`.

Native chooser responses are supplied by the harness; the actual preload bridge and filesystem operations run. The Windows clipboard check is skipped by default to preserve the user's clipboard. Enable `SJ_PAINT_TEST_CLIPBOARD=1` only in an isolated test environment where clipboard changes are authorized. Hidden checks do not establish visible window behavior, native chooser interaction or physical printing.

## Isolated Linux verification

`npm run test:linux` expects an already running, disposable Linux container with Xvfb, Electron's GTK/NSS/ALSA dependencies and socat. Mount `release/linux-unpacked` read-only at `/paint`, start the virtual display at `:99`, and proxy container port 9229 to container loopback port 9230.

Launch the app inside that container with:

```sh
DISPLAY=:99 /paint/sj-paint --no-sandbox --disable-gpu \
  --inspect=0.0.0.0:9231 --remote-debugging-port=9230
```

Publish test ports 9229 and 9231 to host **127.0.0.1 only**, then run `npm run test:linux` from the source checkout. The script replaces native chooser responses through the Node inspector and exercises real IPC, codecs, temporary files and the container's clipboard. Stop the container when testing is complete.

CI also runs the packaged app under Xvfb on its disposable Ubuntu runner, using loopback inspectors and the runner's disposable clipboard. It archives that verified Linux build and retains the package and verification reports as workflow artifacts.

The `--no-sandbox` switch is limited to isolated test environments. It is not part of the shipped launcher and is not a normal desktop workaround. Inspector ports and chooser overrides are test-only controls. This harness does not test native chooser interaction, physical printing or a user's real desktop environment.

The separate installed-product check runs only on an owned disposable Linux X11 display after `npm run archive:linux`:

```sh
SJ_PAINT_DISPOSABLE_DISPLAY=1 xvfb-run -a python3 scripts/verify-installed-linux.py
```

It extracts the real archive into a temporary home, runs the per-user installer and launches the unmodified desktop entry through GIO with normal sandboxing. A second instrumented entry exercises drawing, project Save/reopen and close against that installed binary. Its report distinguishes original-launch readiness from the instrumented workflow. Cleanup retains ownership until the launched process group exits. A diagnostic candidate has passed this journey on Ubuntu 24.04 plus actual Xfce Graphics-menu launch and normal close. That result belongs to its recorded source snapshot; rerun against final release artifacts. See [PARITY.md](PARITY.md) for current evidence and remaining acceptance.

## Reporting a problem

Include the app version, Windows version or Linux distribution, browser version when applicable, minimal reproduction steps, expected behavior and observed behavior. Attach a small sample image or project when useful and safe to share. State whether the issue occurs in the development editor, packaged desktop app or both.

For vulnerabilities, use [private security reporting](SECURITY.md) rather than posting exploit details in a public issue.
