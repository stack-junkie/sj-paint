#!/bin/sh
set -eu
test "$(uname -s)" = Linux || { echo 'This installer is for Linux.' >&2; exit 1; }
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
test -x "$source_dir/sj-paint" || { echo 'Extract the Linux release archive first.' >&2; exit 1; }
install_parent="$HOME/.local/opt"
destination="$install_parent/sj-paint"
data_home=${XDG_DATA_HOME:-"$HOME/.local/share"}
if [ "$(printf '%s' "$HOME$data_home" | LC_ALL=C tr -d '\000-\037\177')" != "$HOME$data_home" ]; then
  echo 'Installation paths must not contain control characters.' >&2; exit 1
fi
case "$data_home" in /*) ;; *) echo 'XDG_DATA_HOME must be an absolute path.' >&2; exit 1;; esac
desktop_dir="$data_home/applications"
icon_dir="$data_home/icons/hicolor/scalable/apps"
desktop_file="$desktop_dir/io.stackjunkie.sjpaint.desktop"
icon_file="$icon_dir/io.stackjunkie.sjpaint.svg"
for target in "$destination" "$desktop_file" "$icon_file"; do
  if [ -L "$target" ]; then echo "Refusing to replace a symbolic link: $target" >&2; exit 1; fi
done
if [ -e "$destination" ] && [ ! -f "$destination/.sj-paint-install" ]; then
  echo "Refusing to replace an unmanaged directory: $destination" >&2; exit 1
fi
if [ -e "$desktop_file" ] && ! grep -qx 'X-SJPaint-Managed=true' "$desktop_file"; then
  echo "Refusing to replace an unmanaged launcher: $desktop_file" >&2; exit 1
fi
if [ -e "$icon_file" ] && { [ ! -f "$destination/.sj-paint-install" ] || ! cmp -s "$icon_file" "$destination/assets/sj-paint.svg"; }; then
  echo "Refusing to replace an unmanaged icon: $icon_file" >&2; exit 1
fi
mkdir -p "$install_parent" "$desktop_dir" "$icon_dir"
stage=$(mktemp -d "$install_parent/.sj-paint-stage.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT HUP INT TERM
cp -a "$source_dir/." "$stage/"
printf 'Stack Junkie Paint per-user installation\n' > "$stage/.sj-paint-install"
chmod 755 "$stage/sj-paint" "$stage/run-paint.sh"
if [ -e "$destination" ]; then
  backup="$install_parent/sj-paint.backup.$(date +%s).$$"
  mv -- "$destination" "$backup"
  printf 'Previous installation retained at %s\n' "$backup"
fi
mv -- "$stage" "$destination"
cp "$destination/assets/sj-paint.svg" "$icon_file"
# Escape both Desktop Entry string parsing and Exec quoted-argument parsing.
exec_path=$(printf '%s' "$destination/run-paint.sh" | sed 's/\\/\\\\\\\\/g; s/"/\\\\"/g; s/[$`]/\\\\&/g; s/%/%%/g')
{
  printf '[Desktop Entry]\nType=Application\nName=Stack Junkie Paint\nGenericName=Image Editor\n'
  printf 'Comment=A Microsoft Paint-inspired editor for Windows and Linux\n'
  # GIO checks argv[0] before expanding %% field escapes. Keep the executable
  # fixed and pass the encoded launcher path as a script argument, not shell code.
  printf 'Exec=/bin/sh "%s"\n' "$exec_path"
  printf 'Icon=io.stackjunkie.sjpaint\nTerminal=false\nCategories=Graphics;2DGraphics;RasterGraphics;\n'
  printf 'StartupWMClass=sj-paint\nX-SJPaint-Managed=true\n'
} > "$desktop_file"
chmod 644 "$desktop_file" "$icon_file"
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database "$desktop_dir" || true; fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -f -t "$data_home/icons/hicolor" >/dev/null 2>&1 || true; fi
printf 'Installed Stack Junkie Paint. Find it in your app drawer under Graphics.\nLauncher: %s\n' "$desktop_file"
