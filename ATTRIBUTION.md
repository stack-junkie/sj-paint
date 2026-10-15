# Attribution

Paint for Linux is an independent drawing editor inspired by the layout and behavior of modern Microsoft Paint. Microsoft Paint and Windows are Microsoft product names. This project is not affiliated with, endorsed by or sponsored by Microsoft.

The implementation uses independently written editing and rendering code and newly drawn icons. Microsoft executables, icon assets and model weights are not included. The reference and limits of the comparison are documented in [PARITY.md](PARITY.md).

[REA](https://github.com/morluto/rea) was used for static inspection of the reference application's executable resources. That inspection helped establish resource inventory; it does not establish behavioral equivalence.

## Dependencies

The desktop application is built with [Electron](https://www.electronjs.org/), which includes Chromium and Node.js. Development and packaging use [Vite](https://vite.dev/) and [electron-builder](https://www.electron.build/). Browser verification uses [Playwright](https://playwright.dev/).

Dependencies retain their own licenses. Packaged distributions include `LICENSE.electron.txt` and `LICENSES.chromium.html`; retain those notices when redistributing the app. The dependency versions are recorded in `package-lock.json`.

Project source code is provided under the [MIT license](LICENSE).
