#!/bin/sh
set -eu
paint_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$paint_dir/paint-linux" "$@"
