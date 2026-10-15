#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
test "$(uname -s)" = Linux || { echo 'Create the archive on Linux to preserve Unix permissions.' >&2; exit 1; }
version=$(cat VERSION)
case "$version" in ''|*[!0-9A-Za-z.+-]*) echo 'Invalid VERSION' >&2; exit 1;; esac
test -f release/linux-unpacked/sj-paint
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT HUP INT TERM
mkdir "$stage/sj-paint"
cp -a release/linux-unpacked/. "$stage/sj-paint/"
cp run-paint.sh install-linux.sh README.md PARITY.md LICENSE ATTRIBUTION.md CHANGELOG.md CONTRIBUTING.md SECURITY.md "$stage/sj-paint/"
cp -a assets "$stage/sj-paint/"
cp -a docs "$stage/sj-paint/"
find "$stage/sj-paint" -type d -exec chmod 755 {} +
find "$stage/sj-paint" -type f -exec chmod 644 {} +
chmod 755 "$stage/sj-paint/run-paint.sh" "$stage/sj-paint/install-linux.sh" "$stage/sj-paint/sj-paint" "$stage/sj-paint/chrome-sandbox" "$stage/sj-paint/chrome_crashpad_handler"
archive="sj-paint-$version-linux-x64.tar.gz"
tar -czf "release/$archive" -C "$stage" sj-paint
(cd release && sha256sum "$archive" > "$archive.sha256")
printf 'Created release/%s and its SHA-256 checksum\n' "$archive"
