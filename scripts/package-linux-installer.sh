#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
test "$(uname -s)" = Linux || { echo 'Build the Linux installer on Linux.' >&2; exit 1; }
version=$(cat VERSION)
case "$version" in ''|*[!0-9A-Za-z.+-]*) echo 'Invalid VERSION' >&2; exit 1;; esac
test -x release/linux-unpacked/sj-paint || { echo 'Run npm run package:linux first.' >&2; exit 1; }
packaged_version=$(node --input-type=module -e "import {extractFile} from '@electron/asar'; console.log(JSON.parse(extractFile('release/linux-unpacked/resources/app.asar', 'package.json')).version)")
test "$packaged_version" = "$version" || { echo 'Packaged version differs from VERSION. Run npm run package:linux first.' >&2; exit 1; }
node node_modules/electron-builder/cli.js --linux deb --x64 --prepackaged release/linux-unpacked --publish never
package="sj-paint-$version-linux-amd64.deb"
(cd release && sha256sum "$package" > "$package.sha256")
printf 'Created release/%s and its SHA-256 checksum\n' "$package"
