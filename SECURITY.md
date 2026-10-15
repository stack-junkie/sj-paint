# Security

## Reporting a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/stack-junkie/paint-linux/security/advisories/new) for vulnerabilities in Paint for Linux. Include the affected version, platform, reproduction steps, expected impact and a minimal sample when available. Keep exploit details and sensitive files out of public issues.

If private reporting is unavailable, open a public issue asking for a private reporting channel without including exploit details or sensitive data. Response and fix timelines are best effort.

## Supported versions

Security fixes target the latest release. Older releases are not maintained as separate security branches. The project is an early release and has not received an independent security audit.

## Security boundaries

Paint for Linux processes local images and projects. The desktop renderer uses Electron sandboxing and context isolation; a narrow preload API mediates native dialogs and file access. The app does not expose Node.js to the renderer. File and document limits reduce resource use, but do not replace safe decoder behavior or dependency updates.

Debug inspector ports and native-dialog overrides are only for disposable test environments. The shipped launcher does not enable them or disable Chromium's sandbox. Do not expose test inspector ports beyond loopback.

Reports about renderer isolation, IPC sender validation, arbitrary file access, malformed project handling, resource exhaustion and loss of existing saved content are especially useful.
