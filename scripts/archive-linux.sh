#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
test "$(uname -s)" = Linux || { echo 'Create the archive on Linux to preserve Unix permissions.' >&2; exit 1; }
version=$(cat VERSION)
case "$version" in ''|*[!0-9A-Za-z.+-]*) echo 'Invalid VERSION' >&2; exit 1;; esac
test -f release/linux-unpacked/paint-linux
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT HUP INT TERM
mkdir "$stage/paint-linux"
cp -a release/linux-unpacked/. "$stage/paint-linux/"
cp run-paint.sh README.md PARITY.md LICENSE ATTRIBUTION.md CHANGELOG.md CONTRIBUTING.md SECURITY.md "$stage/paint-linux/"
cp -a docs "$stage/paint-linux/"
find "$stage/paint-linux" -type d -exec chmod 755 {} +
find "$stage/paint-linux" -type f -exec chmod 644 {} +
chmod 755 "$stage/paint-linux/run-paint.sh" "$stage/paint-linux/paint-linux" "$stage/paint-linux/chrome-sandbox" "$stage/paint-linux/chrome_crashpad_handler"
archive="paint-linux-$version-linux-x64.tar.gz"
tar -czf "release/$archive" -C "$stage" paint-linux
(cd release && sha256sum "$archive" > "$archive.sha256")
printf 'Created release/%s and its SHA-256 checksum\n' "$archive"
