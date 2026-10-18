# Stack Junkie Paint

Stack Junkie Paint (SJ Paint) is a Microsoft Paint-inspired desktop drawing app for Windows and Linux, with brushes, shapes, selections, text and layers. Windows is the primary desktop platform.

Version: 0.3.0
<!-- sj-paint-version: 0.3.0 -->

SJ Paint is an independent drawing editor inspired by Microsoft Paint. It does not claim exact Microsoft Paint parity. Microsoft account and cloud-service replication are outside its scope. The [coverage inventory](PARITY.md) records supported features, compatibility limits and verification evidence.

![Stack Junkie Paint drawing workspace on Windows](docs/sj-paint.png)

## Download

Portable packages are provided for Windows x64 and Linux x64.

### Windows

Download the [v0.3.0 Windows x64 ZIP](https://github.com/stack-junkie/sj-paint/releases/download/v0.3.0/sj-paint-0.3.0-windows-x64.zip), extract it, and open `Stack Junkie Paint.exe` in the extracted folder. Keep the application files together.

The Windows executable is currently unsigned; it has no Authenticode signature.

### Linux

Download the [v0.3.0 Linux x64 archive](https://github.com/stack-junkie/sj-paint/releases/download/v0.3.0/sj-paint-0.3.0-linux-x64.tar.gz), then run:

```sh
tar -xzf sj-paint-0.3.0-linux-x64.tar.gz
./sj-paint/run-paint.sh
```

To install a copy for your user and add SJ Paint to the Linux application menu:

```sh
./sj-paint/install-linux.sh
```

The installer copies the app to `~/.local/opt/sj-paint`, creates `~/.local/share/applications/io.stackjunkie.sjpaint.desktop`, and installs icons under `~/.local/share/icons/hicolor/`. It does not require a system-wide installation.

Both portable archives bundle Electron, so Node.js is not needed to run them. SHA-256 checksums are included on the [release page](https://github.com/stack-junkie/sj-paint/releases/tag/v0.3.0). Use a normal desktop user.

Linux needs Electron's GTK, NSS, X11 and ALSA system libraries. Ubuntu 22.04 package names include `libgtk-3-0`, `libnss3`, `libatk-bridge2.0-0`, `libxdamage1` and `libasound2`; names vary by distribution. Normal startup keeps Chromium sandboxing enabled and does not add `--no-sandbox`.

## Features

- Pencil, brush, eraser, calligraphy, airbrush, oil, crayon, marker, natural pencil and watercolor tools.
- 23 shapes, curves and polygons, with outline and fill controls.
- Fill tolerance, color picker, palette and custom colors, tool sizes and opacity.
- Multiline text with font, size, bold, italic, underline, strikethrough, alignment and background controls.
- Rectangular and free-form selections, inverse selection, transparency, move, resize, crop, copy, cut and paste.
- Image rotation, flips, resize, skew, color inversion and canvas resizing.
- Layer creation, duplication, reordering, naming, visibility, opacity, merging and transparent backgrounds.
- Undo/redo, editable `.sjpaint` projects, legacy `.linuxpaint` import, native file dialogs, clipboard and print integration.
- Dark and light themes, zoom, grid, rulers, full screen and a collapsible toolbar.

Brush textures and rendering are independently implemented approximations. Their exact Microsoft Paint behavior has not been established. See the [parity gaps](PARITY.md#baseline-gaps-and-unresolved-behavior) for details.

## Run from source

Use the Node.js version pinned in `.nvmrc` (24.14.0) and npm.

```sh
git clone https://github.com/stack-junkie/sj-paint.git
cd sj-paint
npm ci
npm run dev
```

Open the local URL printed by Vite to develop and test the editor. Desktop integration and local AI require the desktop application:

```sh
npm run build
npm run desktop
```

On Windows, build the unpacked app and portable ZIP:

```sh
npm run package:windows
npm run archive:windows
```

On Linux, build the unpacked app and portable tar archive:

```sh
npm run package:linux
npm run archive:linux
```

The output is under `release/`, including the portable archive and its `.sha256` checksum. Run each archive command on its matching platform after packaging. Archives include documentation and license notices and are attached to GitHub Releases, not stored in Git.

## File formats and local data

| Format | Open | Save | Notes |
| --- | --- | --- | --- |
| PNG | Yes | Yes | Preserves transparency. |
| JPEG | Yes | Yes | Saving flattens transparency against white. |
| WebP | Yes | Yes | Preserves transparency. |
| BMP | Yes | Yes | Saves an uncompressed 24-bit bitmap, flattened against white. |
| GIF | One frame | One frame | Adaptive palette and compressed LZW, without animation editing. Alpha below 128 becomes transparent; other pixels become opaque. |
| TIFF | Supported variants | Yes | Classic RGB/RGBA8, 1/2/4/8-bit grayscale and palette strips with uncompressed, PackBits, LZW or Deflate data. Saves lossless LZW/predictor-2 RGBA with unassociated alpha and known document resolution. |
| `.sjpaint` | Yes | Yes | SJ Paint's layered project format. |
| `.linuxpaint` | Yes | As `.sjpaint` | Legacy projects from Paint for Linux. |
| Microsoft `.paint` | Tested variant | Tested variant | Full-canvas visible BGRA layers, pixel alpha and separate background. Unsupported variants are rejected. |

Raster import uses Chromium's decoders and the app's TIFF and project adapters. GIF export preserves palettes that fit, then uses a bounded adaptive quantizer with deterministic dithering for more complex images. Dithering reduces gradient banding at the cost of some pixel noise and larger files. Transparent pixels neither receive nor relay color error, and a transparent palette entry is reserved only when needed. GIF animation is not preserved.

Images and projects stay on the local computer. The desktop renderer is sandboxed, uses context isolation and accesses files through a narrow preload API and native dialogs. It does not expose Node.js or arbitrary paths to the page. External navigation and new windows are blocked. Desktop saves write and sync an exclusively created sibling file before replacing the destination, preserving the previous file if writing fails.

Projects store canvas dimensions, background, active layer and ordered layers with PNG pixels in `.sjpaint` JSON. Legacy `.linuxpaint` files can be opened and saved in the new format. A `null` background means transparent. File operations accept up to 64 MiB of encoded data. Images may be up to 16384 pixels per side and 32 million total pixels. Documents support up to 64 layers within a shared 128 MiB pixel budget for layers and floating selections. Undo history has a separate 128 MiB budget. These budgets exclude browser, renderer, temporary encoding and other process overhead.

Open `.paint` files through Open, Open project or drag and drop. Choose Paint project in Save As; Ctrl+S keeps that format. Use `.sjpaint` for hidden layers or layer opacity, which the supported `.paint` variant cannot preserve. Resolution is retained; other Exif metadata is not. Unknown properties, cropped or offset layers and other variants are rejected. Native Paint 11.2605.81.0 opened and resaved an SJ Paint codec sample with two separate layers and unchanged decoded pixels. This verifies that sample, not every `.paint` file.

The document owns horizontal and vertical resolution, including explicit unknown values. Properties uses the known horizontal resolution for inches and centimeters, matching the observed Paint dialog while preserving both stored axes. Resizing preserves existing pixels without scaling. Unit preferences change when you accept the dialog; Cancel leaves them unchanged. PNG, JPEG, BMP, TIFF and supported `.paint` density is retained where representable; `.sjpaint` stores it exactly. GIF/WebP export does not retain physical resolution. The file-size field reports the last successful encoded Open/Save size, not an estimate of unsaved edits. Older projects without resolution remain readable.

Clipboard access requires browser support and permission. Printing depends on the browser or operating system print service.

## Verification and known limits

Release packages and their checksums are available on the [release page](https://github.com/stack-junkie/sj-paint/releases/tag/v0.3.0).

[PARITY.md](PARITY.md) is the coverage inventory for implemented behavior, verification evidence and documented limits. Checks exercise editor transactions, file failures, format round trips, AI workflow ownership and installed Linux drawing/save journeys. Native comparisons do not establish identical brush pixels, font metrics or every Microsoft file variant.

Headless browser checks exercise the shared editor. Hidden desktop checks execute real preload IPC, codecs, files and close handling while supplying chooser responses. They do not establish interactive native chooser behavior. The laptop clipboard is left untouched; isolated Linux tests can exercise their own clipboard. Counts distinguish successes, failures and explicit skips.

Microsoft accounts/credits/cloud replication, physical-printer certification, a separate browser product and exhaustive platform certification are outside this release's scope. The existing Print command remains. Unsupported TIFF/project variants produce errors; use the supported format profiles documented above. Committed text and shapes become pixels.

For local checks:

```sh
npm run hooks:install
npm run version:check
npm run test:files
npm test
npm run build
```

`npm test` runs real canvas and UI workflows in headless Chrome and writes `output/verification.json`. It uses installed Google Chrome by default; set `PAINT_CHROME_PATH` to choose another installed Chromium executable. It does not open a visible browser. `npm run test:files` checks native atomic-save behavior using Node.js and temporary files.

`npm run test:windows` exercises the packaged Windows app in an owned, hidden window with a temporary profile. Native chooser responses are supplied by the harness, and the Windows clipboard is left alone by default. See [CONTRIBUTING.md](CONTRIBUTING.md#hidden-windows-verification) for the setup and report paths.

`npm run test:linux` targets a separately prepared, disposable Linux Xvfb container at loopback ports 9229 and 9231. It writes `output/linux-verification.json`. See [CONTRIBUTING.md](CONTRIBUTING.md#isolated-linux-verification) for the harness requirements; do not point it at a personal desktop session.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and reporting guidance, [SECURITY.md](SECURITY.md) for private vulnerability reports, and [ATTRIBUTION.md](ATTRIBUTION.md) for reference and dependency notices.

Released under the [MIT license](LICENSE).

## Local AI setup and use

Managed AI supports Windows x64 and Linux x64. Choose **AI > Set up local AI**, or open an operation to install its required capability. The released operations are **Remove background**, **Object select** and **Generative erase**. They run on the CPU and do not require a GPU, account or paid service. Setup shows download size, required space, licenses and progress before installation. It installs a private Python runtime and pinned dependencies in the application's data directory without changing system Python or drivers.

Setup requires network access to pinned upstream downloads. Each artifact is checked against its recorded SHA-256 digest before activation. Cancel retains verified downloads for retry. Drawing pixels are processed locally and are not uploaded. Normal use needs no environment variables. Legacy configuration and previously installed assets cannot enable excluded operations.

Background removal previews the active layer and preserves existing transparency. Object selection accepts Include/Exclude points or a box directly on the canvas. When different masks are available, choose a Selection preview to recover missing parts of the object. Apply creates a normal selection that can be moved, copied, cut, deleted or transformed. Generative erase requires a selection and preserves pixels outside it. It uses a separate CPU model to reconstruct the surroundings without a prompt; include the object's shadow in the selection. Each accepted edit is one Undo step. Editing the source invalidates stale previews. Close cancels an operation and releases its worker.

Only one AI operation runs at a time. Background removal accepts images up to 16 million pixels. Erase processes a scaled copy of the active layer and selection, at most 1024 pixels on either side; mapping back can soften detail inside the selection. Photographic fringes, difficult masks and small reconstruction blemishes remain possible. Inspect the preview before Apply. See [PARITY.md](PARITY.md) for exercised examples and limits.

For a setup network, integrity or capacity error, address the reported condition and retry. A failed operation leaves the drawing unchanged. SJ Paint does not close other applications. Models remain separate downloads, with licenses listed in [ATTRIBUTION.md](ATTRIBUTION.md). Existing acquired assets are preserved across application updates.

Image creation, Cocreator, Generative Fill, Reimagine, stickers and coloring pages are excluded from v0.3.0. They are absent from the interface, rejected by the desktop bridge and unavailable in new setup.
