#!/usr/bin/env python3
"""Run only on an owned disposable Linux display. No host installation."""
import ctypes
import ctypes.util
import hashlib
from contextlib import contextmanager
import json
import os
from pathlib import Path
import signal
import shutil
import socket
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "output"
CHECKS = []
OWNED_PIDS = set()
RETAINED_WORKSPACES = []


@contextmanager
def installed_workspace():
    temporary = tempfile.mkdtemp(prefix="sj-paint-installed-")
    try:
        yield temporary
    finally:
        if OWNED_PIDS:
            # Do not remove the installation/profile beneath an unresolved child.
            RETAINED_WORKSPACES.append({"path": temporary, "ownedPids": sorted(OWNED_PIDS)})
        else:
            shutil.rmtree(temporary)


def check(name, condition, detail=None):
    CHECKS.append({"name": name, "ok": bool(condition), "detail": detail})
    if not condition:
        raise RuntimeError(name + (": " + str(detail) if detail else ""))


def window_for_pid(pid):
    """Read X11 properties, without activating a window or supplying input."""
    x = ctypes.CDLL(ctypes.util.find_library("X11"))
    x.XOpenDisplay.restype = ctypes.c_void_p
    x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    x.XDefaultRootWindow.restype = ctypes.c_ulong
    x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    x.XInternAtom.restype = ctypes.c_ulong
    x.XQueryTree.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong),
                            ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.POINTER(ctypes.c_ulong)),
                            ctypes.POINTER(ctypes.c_uint)]
    x.XGetWindowProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long,
                                    ctypes.c_long, ctypes.c_int, ctypes.c_ulong,
                                    ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_int),
                                    ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
                                    ctypes.POINTER(ctypes.c_void_p)]
    x.XFree.argtypes = [ctypes.c_void_p]
    x.XCloseDisplay.argtypes = [ctypes.c_void_p]
    display = x.XOpenDisplay(None)
    if not display:
        raise RuntimeError("Cannot connect to the owned X11 display")
    try:
        atom = x.XInternAtom(display, b"_NET_WM_PID", 1)
        if not atom:
            return False
        root = x.XDefaultRootWindow(display)
        actual_root, parent, count = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_uint()
        children = ctypes.POINTER(ctypes.c_ulong)()
        if not x.XQueryTree(display, root, ctypes.byref(actual_root), ctypes.byref(parent),
                            ctypes.byref(children), ctypes.byref(count)):
            return False
        try:
            for window in children[:count.value]:
                kind, length, after = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.c_ulong()
                fmt, data = ctypes.c_int(), ctypes.c_void_p()
                status = x.XGetWindowProperty(display, window, atom, 0, 1, 0, 0,
                                             ctypes.byref(kind), ctypes.byref(fmt), ctypes.byref(length),
                                             ctypes.byref(after), ctypes.byref(data))
                try:
                    if status == 0 and data.value and fmt.value == 32 and length.value == 1:
                        if ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))[0] == pid:
                            return True
                finally:
                    if data.value:
                        x.XFree(data)
        finally:
            if children:
                x.XFree(children)
        return False
    finally:
        x.XCloseDisplay(display)


def launch_gio(desktop):
    gio = ctypes.CDLL(ctypes.util.find_library("gio-2.0"))
    gobject = ctypes.CDLL(ctypes.util.find_library("gobject-2.0"))
    gio.g_desktop_app_info_new_from_filename.argtypes = [ctypes.c_char_p]
    gio.g_desktop_app_info_new_from_filename.restype = ctypes.c_void_p
    setup_type = ctypes.CFUNCTYPE(None, ctypes.c_void_p)
    pid_type = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p)
    gio.g_desktop_app_info_launch_uris_as_manager.argtypes = [ctypes.c_void_p, ctypes.c_void_p,
        ctypes.c_void_p, ctypes.c_int, setup_type, ctypes.c_void_p, pid_type, ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_void_p)]
    gio.g_desktop_app_info_launch_uris_as_manager.restype = ctypes.c_int
    glib = ctypes.CDLL(ctypes.util.find_library("glib-2.0"))
    glib.g_error_free.argtypes = [ctypes.c_void_p]
    gobject.g_object_unref.argtypes = [ctypes.c_void_p]
    app = gio.g_desktop_app_info_new_from_filename(os.fsencode(desktop))
    if not app:
        raise RuntimeError("GIO could not parse installed launcher")
    pids = []
    setup = setup_type(lambda _: os.setsid())
    def launched(_app, pid, _data):
        pids.append(pid)
        OWNED_PIDS.add(pid)
    callback = pid_type(launched)
    error = ctypes.c_void_p()
    try:
        # DO_NOT_REAP_CHILD retains a waitable launch-owned PID until cleanup.
        success = gio.g_desktop_app_info_launch_uris_as_manager(app, None, None, 2,
            setup, None, callback, None, ctypes.byref(error))
        if not success or len(pids) != 1:
            for pid in pids:
                stop_owned(pid)
            raise RuntimeError("GIO launch failed or did not return exactly one owned child")
        return pids[0]
    finally:
        if error.value:
            glib.g_error_free(error)
        gobject.g_object_unref(app)


def stop_owned(pid):
    if pid not in OWNED_PIDS:
        raise RuntimeError(f"Refusing cleanup of unowned PID {pid}")
    # The unreaped child owns this session/group, so its PID cannot be reused.
    try:
        group_owned = os.getpgid(pid) == pid
    except ProcessLookupError:
        group_owned = False
    send = (lambda value: os.killpg(pid, value)) if group_owned else (lambda value: os.kill(pid, value))
    try:
        send(signal.SIGTERM)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        # Observe exit without reaping: the launch-owned PID stays reserved
        # while any child in its dedicated session still needs termination.
        ended = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        if ended and (not group_owned or not active_session_members(pid)):
            os.waitpid(pid, 0)
            OWNED_PIDS.remove(pid)
            return
        time.sleep(.05)
    try:
        send(signal.SIGKILL)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        ended = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        if ended and (not group_owned or not active_session_members(pid)):
            os.waitpid(pid, 0)
            OWNED_PIDS.remove(pid)
            return
        time.sleep(.05)
    raise RuntimeError(f"Owned application cleanup incomplete: unreaped PID/session {pid}")


def active_session_members(owner_pid):
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            raw = (entry / "stat").read_text()
        except FileNotFoundError:
            continue
        # comm may contain spaces and parentheses. Remaining fields start at
        # state; process group and session are its third and fourth fields.
        fields = raw[raw.rfind(")") + 2:].split()
        if fields[0] != "Z" and int(fields[2]) == owner_pid and int(fields[3]) == owner_pid:
            return True
    return False


def available_port():
    with socket.socket() as owned:
        owned.bind(("127.0.0.1", 0))
        return owned.getsockname()[1]


def run():
    if sys.platform != "linux" or os.environ.get("SJ_PAINT_DISPOSABLE_DISPLAY") != "1":
        raise RuntimeError("Requires Linux and SJ_PAINT_DISPOSABLE_DISPLAY=1 on an owned Xvfb display")
    if not os.environ.get("DISPLAY"):
        raise RuntimeError("An owned X11 display is required")
    workflow = os.environ.get("SJ_PAINT_TEST_WORKFLOW", "editor")
    if workflow not in ("editor", "managed-status", "managed-ai", "managed-generation"):
        raise RuntimeError("Unknown installed Linux verification workflow")
    profile = None
    profile_receipt = None
    if workflow != "editor":
        profile = Path(os.environ.get("SJ_PAINT_TEST_MANAGED_PROFILE", ""))
        if not profile.is_absolute() or not profile.is_dir() or profile.is_symlink():
            raise RuntimeError("Managed workflow requires an existing absolute task-owned profile")
        profile_receipt = (profile / "ai/active.json").read_bytes()
        if workflow == "managed-generation":
            sampler = Path(os.environ.get("SJ_PAINT_TEST_CAPACITY_SAMPLER", ""))
            destination = Path(os.environ.get("SJ_PAINT_TEST_GENERATION_OUTPUT", ""))
            if not sampler.is_absolute() or not sampler.is_file() or not destination.is_absolute() or destination.exists():
                raise RuntimeError("Generation requires an absolute capacity sampler and a fresh absolute output directory")
            photo = Path(os.environ.get("SJ_PAINT_TEST_PHOTO", ""))
            if not photo.is_absolute() or not photo.is_file():
                raise RuntimeError("Generation requires the existing absolute photo edit fixture")
        if workflow == "managed-ai":
            photo = Path(os.environ.get("SJ_PAINT_TEST_PHOTO", ""))
            destination = Path(os.environ.get("SJ_PAINT_TEST_AI_OUTPUT", ""))
            if not photo.is_absolute() or not photo.is_file():
                raise RuntimeError("Managed inference requires an existing absolute photo fixture")
            if not destination.is_absolute() or destination.exists():
                raise RuntimeError("Managed inference requires a fresh absolute retained output directory")
    for key in ["SJ_PAINT_PYTHON", "SJ_PAINT_U2NETP_MODEL", "SJ_PAINT_EFFICIENTSAM_ENCODER",
                "SJ_PAINT_EFFICIENTSAM_DECODER", "SJ_PAINT_GENERATIVE_PYTHON", "SJ_PAINT_SDXL_MODEL"]:
        os.environ.pop(key, None)
    with installed_workspace() as temporary:
        base = Path(temporary)
        version = (ROOT / "VERSION").read_text().strip()
        archive = ROOT / "release" / f"sj-paint-{version}-linux-x64.tar.gz"
        system_package = os.environ.get("SJ_PAINT_TEST_SYSTEM_PACKAGE") == "1"
        if not system_package:
            subprocess.run(["tar", "-xzf", str(archive), "-C", str(base)], check=True, timeout=30)
        release = base / "sj-paint"
        home = base / "home"
        home.mkdir()
        os.environ.update({"HOME": str(home), "XDG_DATA_HOME": str(home / ".local/share"),
            "XDG_CONFIG_HOME": str(home / ".config"), "XDG_CACHE_HOME": str(home / ".cache"),
            "XDG_STATE_HOME": str(home / ".local/state"), "XDG_RUNTIME_DIR": str(home / "runtime")})
        Path(os.environ["XDG_RUNTIME_DIR"]).mkdir(mode=0o700)
        os.environ.pop("DBUS_SESSION_BUS_ADDRESS", None)
        os.environ.pop("WAYLAND_DISPLAY", None)
        if system_package:
            # Only on the disposable machine, after installing the real .deb.
            desktop = Path("/usr/share/applications/io.stackjunkie.sjpaint.desktop")
            executable = Path("/opt/Stack Junkie Paint/sj-paint")
            installed_version = subprocess.check_output(
                ["dpkg-query", "-W", "-f=${Version}", "sj-paint"], text=True).strip()
            check("installed system package matches the candidate", installed_version == version)
            subprocess.run(["desktop-file-validate", str(desktop)], check=True, timeout=10)
            gio = ctypes.CDLL(ctypes.util.find_library("gio-2.0"))
            gobject = ctypes.CDLL(ctypes.util.find_library("gobject-2.0"))
            gio.g_desktop_app_info_new.argtypes = [ctypes.c_char_p]
            gio.g_desktop_app_info_new.restype = ctypes.c_void_p
            gio.g_app_info_should_show.argtypes = [ctypes.c_void_p]
            gio.g_app_info_should_show.restype = ctypes.c_int
            gobject.g_object_unref.argtypes = [ctypes.c_void_p]
            registered = gio.g_desktop_app_info_new(desktop.name.encode())
            check("GIO discovers the system app-menu entry", bool(registered))
            try:
                check("system app-menu entry is visible", bool(gio.g_app_info_should_show(registered)))
            finally:
                gobject.g_object_unref(registered)
        else:
            subprocess.run(["sh", str(release / "install-linux.sh")], check=True, timeout=30)
            desktop = home / ".local/share/applications/io.stackjunkie.sjpaint.desktop"
            executable = home / ".local/opt/sj-paint/sj-paint"
        original = desktop.read_bytes()
        pid = launch_gio(desktop)
        try:
            deadline = time.monotonic() + 30
            ready = False
            while time.monotonic() < deadline:
                if window_for_pid(pid):
                    ready = True
                    break
                time.sleep(.1)
            check("original installed GIO launcher creates an application window", ready)
            check("original launcher runs the installed executable", Path(f"/proc/{pid}/exe").resolve() == executable.resolve())
            check("normal installed launch retains sandboxing", b"--no-sandbox" not in Path(f"/proc/{pid}/cmdline").read_bytes())
        finally:
            stop_owned(pid)
        check("original installed launch exits through owned cleanup", not Path(f"/proc/{pid}").exists())

        main_port, renderer_port = available_port(), available_port()
        while renderer_port == main_port:
            renderer_port = available_port()
        instrumented = base / "instrumented.desktop"
        # Desktop-entry quoting is not shell quoting. Keep a supplied profile
        # one argument and preserve literal percent signs instead of field codes.
        def desktop_argument(value):
            return '"' + value.replace('\\', '\\\\').replace('"', '\\"').replace('`', '\\`').replace('$', '\\$').replace('%', '%%') + '"'
        profile_argument = " " + desktop_argument("--user-data-dir=" + str(profile)) if profile else ""
        instrumented.write_text("\n".join(line + f" --inspect=127.0.0.1:{main_port} --remote-debugging-port={renderer_port}" + profile_argument
            if line.startswith("Exec=") else line for line in original.decode().splitlines()) + "\n")
        pid = launch_gio(instrumented)
        try:
            env = {**os.environ, "SJ_PAINT_TEST_PID": str(pid), "SJ_PAINT_TEST_EXECUTABLE": str(executable),
                "SJ_PAINT_MAIN_PORT": str(main_port), "SJ_PAINT_RENDERER_PORT": str(renderer_port),
                "SJ_PAINT_TEST_FILE": str(base / "drawing.sjpaint")}
            result = subprocess.run(["node", str(ROOT / "scripts/verify-installed-linux-workflow.mjs")],
                                    env=env, timeout=3000 if workflow == "managed-generation" else 600 if workflow == "managed-ai" else 120)
            check("instrumented installed GIO workflow passes", result.returncode == 0)
        finally:
            stop_owned(pid)
        check("instrumentation preserves the installed desktop entry", desktop.read_bytes() == original)
        if profile:
            current = (profile / "ai/active.json").read_bytes()
            check("installed workflow preserves the managed activation receipt", current == profile_receipt,
                  {"profile": str(profile), "sha256": hashlib.sha256(current).hexdigest()})


OUTPUT.mkdir(exist_ok=True)
exit_code = 0
try:
    run()
except Exception as error:
    CHECKS.append({"name": "installed Linux verification failure", "ok": False, "detail": str(error)})
    exit_code = 1
finally:
    (OUTPUT / "linux-installed-launch.json").write_text(json.dumps({"checks": CHECKS,
        "installation": "system-deb" if os.environ.get("SJ_PAINT_TEST_SYSTEM_PACKAGE") == "1" else "per-user-archive",
        "workflow": os.environ.get("SJ_PAINT_TEST_WORKFLOW", "editor"),
        "retainedWorkspaces": RETAINED_WORKSPACES,
        "limitations": "Owned X11 display. Original installed launcher readiness, then an instrumented desktop-entry copy for drawing/file workflow. No GNOME/KDE menu visual or Wayland acceptance."}, indent=2))
sys.exit(exit_code)
