# Security

## Reporting a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/stack-junkie/sj-paint/security/advisories/new) for vulnerabilities in Stack Junkie Paint. Include the affected version, platform, reproduction steps, expected impact and a minimal sample when available. Keep exploit details and sensitive files out of public issues.

If private reporting is unavailable, open a public issue asking for a private reporting channel without including exploit details or sensitive data. Response and fix timelines are best effort.

## Supported versions

Security fixes target the latest release. Older releases are not maintained as separate security branches. The project is an early release and has not received an independent security audit.

## Security boundaries

Version 0.2.0 bundles Electron 44.7.2. The dependency audit on 2026-10-15 reported no high-severity runtime advisory after this update. Eight moderate audit entries remain in the packaging dependency chain through `electron-builder`, `@electron/get`, `global-agent`, `roarr` and `sprintf-js`. These tools run during builds and are not included in the packaged application. The underlying advisory concerns unbounded formatting precision in `sprintf-js`; this is not a claim that the full dependency tree is vulnerability-free.

Stack Junkie Paint processes local images and projects on Windows, Linux and in its browser edition. The desktop renderer uses Electron sandboxing and context isolation; a narrow preload API mediates native dialogs and file access. The app does not expose Node.js to the renderer. File and document limits reduce resource use, but do not replace safe decoder behavior or dependency updates.

Debug inspector ports and native-dialog overrides are only for isolated test environments. Normal startup does not enable them or disable Chromium's sandbox. Do not expose test inspector ports beyond loopback.

Reports about renderer isolation, IPC sender validation, arbitrary file access, malformed project handling, resource exhaustion and loss of existing saved content are especially useful.
