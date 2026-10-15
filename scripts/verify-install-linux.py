#!/usr/bin/env python3
"""Exercise the real installer with a harmless executable fixture, never the GUI."""

import ctypes
import ctypes.util
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import traceback
from datetime import datetime, timezone


ROOT = Path(__file__).resolve().parent.parent
DESKTOP_ID = "io.stackjunkie.sjpaint.desktop"
CHECKS = []
SOURCES = {}


def check(name, condition, detail=None):
    CHECKS.append({"name": name, "ok": bool(condition), "detail": detail})
    if not condition:
        raise AssertionError(name + (": " + str(detail) if detail else ""))


def environment(home, data_home=None):
    env = os.environ.copy()
    env.update({
        "HOME": str(home),
        "XDG_DATA_HOME": str(data_home or home / ".local/share"),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_CACHE_HOME": str(home / ".cache"),
        "XDG_STATE_HOME": str(home / ".local/state"),
        "XDG_RUNTIME_DIR": str(home / "runtime"),
        "XDG_DATA_DIRS": str(home / "empty-system-data"),
    })
    for key in ("DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS"):
        env.pop(key, None)
    return env


def install(release, env):
    return subprocess.run(["sh", str(release / "install-linux.sh")], env=env,
                          text=True, capture_output=True, timeout=30)


def load_library(name):
    library = ctypes.util.find_library(name)
    if not library:
        raise RuntimeError("Required installed system library is missing: " + name)
    return ctypes.CDLL(library)


def verify_gio(desktop, destination, marker, env):
    # Set XDG variables before loading GIO: GLib caches user directory lookups.
    previous = os.environ.copy()
    os.environ.clear()
    os.environ.update(env)
    os.environ["SJ_PAINT_INSTALL_MARKER"] = str(marker)
    handles = []
    gobject = None
    try:
        gio = load_library("gio-2.0")
        glib = load_library("glib-2.0")
        gobject = load_library("gobject-2.0")
        gio.g_desktop_app_info_new_from_filename.argtypes = [ctypes.c_char_p]
        gio.g_desktop_app_info_new_from_filename.restype = ctypes.c_void_p
        gio.g_desktop_app_info_new.argtypes = [ctypes.c_char_p]
        gio.g_desktop_app_info_new.restype = ctypes.c_void_p
        for function in (gio.g_app_info_get_name, gio.g_app_info_get_id):
            function.argtypes = [ctypes.c_void_p]
            function.restype = ctypes.c_char_p
        gio.g_app_info_should_show.argtypes = [ctypes.c_void_p]
        gio.g_app_info_should_show.restype = ctypes.c_int
        gio.g_app_info_launch.argtypes = [ctypes.c_void_p, ctypes.c_void_p,
                                        ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
        gio.g_app_info_launch.restype = ctypes.c_int
        glib.g_error_free.argtypes = [ctypes.c_void_p]
        glib.g_error_free.restype = None
        gobject.g_object_unref.argtypes = [ctypes.c_void_p]
        gobject.g_object_unref.restype = None

        parsed = gio.g_desktop_app_info_new_from_filename(os.fsencode(desktop))
        check("GIO parses the generated desktop entry", bool(parsed))
        handles.append(parsed)
        name = gio.g_app_info_get_name(parsed)
        check("desktop entry has the public app name", name == b"Stack Junkie Paint", repr(name))
        check("desktop entry is eligible for app drawer display", bool(gio.g_app_info_should_show(parsed)))
        registered = gio.g_desktop_app_info_new(DESKTOP_ID.encode())
        check("GIO discovers the registered desktop ID", bool(registered))
        handles.append(registered)
        check("GIO returns the expected desktop ID", gio.g_app_info_get_id(registered) == DESKTOP_ID.encode())

        error = ctypes.c_void_p()
        launched = gio.g_app_info_launch(registered, None, None, ctypes.byref(error))
        message = None
        if error.value:
            class GError(ctypes.Structure):
                _fields_ = [("domain", ctypes.c_uint), ("code", ctypes.c_int),
                            ("message", ctypes.c_char_p)]
            failure = ctypes.cast(error, ctypes.POINTER(GError)).contents
            message = failure.message.decode("utf-8", "replace")
            glib.g_error_free(error)
        check("GIO launches the registered fixture", bool(launched), message)
        expected = str(destination / "sj-paint") + "\n"
        deadline = time.monotonic() + 5
        observed = None
        while time.monotonic() < deadline:
            if marker.exists():
                observed = marker.read_text()
                if observed == expected:
                    break
            time.sleep(0.05)
        check("desktop Exec preserves special characters through the real launcher", observed == expected,
              "Marker must contain the exact installed fixture executable path.")
    finally:
        if gobject:
            for handle in handles:
                gobject.g_object_unref(handle)
        os.environ.clear()
        os.environ.update(previous)


def verify_rejection(release, base, kind):
    home = base / kind / "home"
    env = environment(home)
    destination = home / ".local/opt/sj-paint"
    desktop = Path(env["XDG_DATA_HOME"]) / "applications" / DESKTOP_ID
    icon = Path(env["XDG_DATA_HOME"]) / "icons/hicolor/scalable/apps/io.stackjunkie.sjpaint.svg"
    sentinel = base / kind / "sentinel"
    sentinel.parent.mkdir(parents=True)
    sentinel.write_text("untouched sentinel\n")
    if kind == "symlink-app":
        destination.parent.mkdir(parents=True)
        destination.symlink_to(sentinel.parent, target_is_directory=True)
        target = destination
    elif kind in ("symlink-desktop", "symlink-icon"):
        target = desktop if kind == "symlink-desktop" else icon
        target.parent.mkdir(parents=True)
        target.symlink_to(sentinel)
    elif kind == "unmanaged-app":
        destination.mkdir(parents=True)
        shutil.copyfile(sentinel, destination / "owner-file")
        target = destination
    elif kind in ("unmanaged-desktop", "unmanaged-icon"):
        target = desktop if kind == "unmanaged-desktop" else icon
        target.parent.mkdir(parents=True)
        shutil.copyfile(sentinel, target)
    else:
        raise ValueError(kind)
    result = install(release, env)
    check("installer refuses " + kind, result.returncode != 0, result.stderr.strip())
    check(kind + " leaves the sentinel unchanged", sentinel.read_text() == "untouched sentinel\n")
    if kind.startswith("symlink-"):
        check(kind + " leaves the symbolic link intact", target.is_symlink())
    elif kind == "unmanaged-app":
        check("unmanaged app contents are preserved", (target / "owner-file").read_text() == "untouched sentinel\n")
    else:
        check(kind + " leaves the destination unchanged", target.read_text() == "untouched sentinel\n")
    check(kind + " creates no managed app or backups",
          not (destination / ".sj-paint-install").exists() and not list(destination.parent.glob("sj-paint.backup.*")))


def run():
    if sys.platform != "linux":
        raise RuntimeError("Run this installer verification on Linux. It does not install system dependencies.")
    with tempfile.TemporaryDirectory(prefix="sj-paint-install-test-") as temporary:
        base = Path(temporary)
        # Characters exercise shell handling plus both Desktop Entry escaping layers.
        unusual = "space $cash %percent 'single' \"double\" \\backslash `tick`"
        release = base / ("release " + unusual)
        (release / "assets").mkdir(parents=True)
        for relative in ("install-linux.sh", "run-paint.sh", "assets/sj-paint.svg"):
            source = (ROOT / relative).read_bytes()
            SOURCES[relative] = hashlib.sha256(source).hexdigest()
            (release / relative).write_bytes(source)
        (release / "sj-paint").write_text('#!/bin/sh\nset -eu\nprintf \'%s\\n\' "$0" > "$SJ_PAINT_INSTALL_MARKER"\n')
        for name in ("sj-paint", "run-paint.sh", "install-linux.sh"):
            (release / name).chmod(0o755)
        (release / "generation.txt").write_text("first generation\n")

        home = base / ("home " + unusual)
        home.mkdir()
        env = environment(home, home / ("data " + unusual))
        Path(env["XDG_RUNTIME_DIR"]).mkdir(mode=0o700)
        Path(env["XDG_DATA_DIRS"]).mkdir()
        result = install(release, env)
        check("installer succeeds with special-character HOME and XDG paths", result.returncode == 0,
              result.stderr.strip() if result.returncode else None)
        destination = home / ".local/opt/sj-paint"
        desktop = Path(env["XDG_DATA_HOME"]) / "applications" / DESKTOP_ID
        icon = Path(env["XDG_DATA_HOME"]) / "icons/hicolor/scalable/apps/io.stackjunkie.sjpaint.svg"
        check("installer copies the actual icon", icon.read_bytes() == (release / "assets/sj-paint.svg").read_bytes())
        check("installed launcher remains executable", os.access(destination / "run-paint.sh", os.X_OK))
        verify_gio(desktop, destination, base / "launch-marker", env)

        (destination / "owner-note.txt").write_text("retain this previous installation\n")
        for generation in ("second", "third"):
            (release / "generation.txt").write_text(generation + " generation\n")
            result = install(release, env)
            check(generation + " installation succeeds", result.returncode == 0,
                  result.stderr.strip() if result.returncode else None)
            check(generation + " installation updates application files",
                  (destination / "generation.txt").read_text() == generation + " generation\n")
        backups = list(destination.parent.glob("sj-paint.backup.*"))
        check("repeated installation retains both previous installations", len(backups) == 2, len(backups))
        generations = {(backup / "generation.txt").read_text(): backup for backup in backups}
        check("backups retain each previous generation", set(generations) == {"first generation\n", "second generation\n"})
        check("first backup retains local files after subsequent reinstall",
              (generations["first generation\n"] / "owner-note.txt").read_text() == "retain this previous installation\n")

        for kind in ("symlink-app", "symlink-desktop", "symlink-icon", "unmanaged-app", "unmanaged-desktop", "unmanaged-icon"):
            verify_rejection(release, base / "refusals", kind)
        for variable in ("HOME", "XDG_DATA_HOME"):
            for character, label in (("\n", "newline"), ("\x01", "control byte"), ("\x7f", "DEL")):
                safe_home = base / "control-refusals" / (variable + "-" + label.replace(" ", "-"))
                safe_home.mkdir(parents=True)
                sentinel = safe_home / "sentinel"
                sentinel.write_text("untouched sentinel\n")
                env = environment(safe_home)
                rejected_path = safe_home / ("bad" + character + "path")
                env[variable] = str(rejected_path)
                result = install(release, env)
                check(variable + " with " + label + " is refused before writing",
                      result.returncode != 0 and not rejected_path.exists()
                      and not (safe_home / ".local").exists()
                      and sentinel.read_text() == "untouched sentinel\n", result.stderr.strip())


def main():
    try:
        run()
    except Exception as error:
        CHECKS.append({"name": "verification failure", "ok": False,
                       "detail": str(error), "traceback": traceback.format_exc()})
    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "platform": sys.platform,
        "scope": "Actual installer, launcher and SVG with a harmless marker executable in TemporaryDirectory; GIO parses, discovers and launches the desktop entry. No real application runtime or GUI is tested.",
        "sourceSha256": SOURCES,
        "checks": CHECKS,
    }
    output = ROOT / "output"
    output.mkdir(exist_ok=True)
    (output / "linux-install-verification.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    failures = [item for item in CHECKS if not item["ok"]]
    print(json.dumps({"passed": sum(item["ok"] for item in CHECKS), "failed": failures}))
    return bool(failures)


if __name__ == "__main__":
    sys.exit(main())
