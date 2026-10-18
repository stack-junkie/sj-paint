"""Read-only Windows host capacity, using only the supplied Python standard library."""
import ctypes
from ctypes import wintypes
import json
import sys
import time

if sys.platform != 'win32':
    raise RuntimeError('Windows host capacity must be sampled on Windows.')


class Capacity(ctypes.Structure):
    _fields_ = [('length', wintypes.DWORD), ('load', wintypes.DWORD)] + [
        (name, ctypes.c_ulonglong) for name in (
            'totalPhysical', 'availablePhysical', 'totalPagefile', 'availablePagefile',
            'totalVirtual', 'availableVirtual', 'availableExtendedVirtual')]


kernel = ctypes.WinDLL('kernel32', use_last_error=True)
kernel.GlobalMemoryStatusEx.argtypes = [ctypes.POINTER(Capacity)]
kernel.GlobalMemoryStatusEx.restype = wintypes.BOOL
kernel.GetCurrentProcess.argtypes = []
kernel.GetCurrentProcess.restype = wintypes.HANDLE
kernel.GetCurrentProcessId.argtypes = []
kernel.GetCurrentProcessId.restype = wintypes.DWORD
kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
kernel.GetProcessTimes.restype = wintypes.BOOL
times = [wintypes.FILETIME() for _ in range(4)]
if not kernel.GetProcessTimes(kernel.GetCurrentProcess(), *[ctypes.byref(value) for value in times]):
    raise ctypes.WinError(ctypes.get_last_error())
# Preserve the exact FILETIME as text; its integer magnitude exceeds JavaScript's
# safe integer range. This identifies the Windows reader across a WSL bridge.
host_reader = {'pid': kernel.GetCurrentProcessId(),
               'creationTime100ns': str((times[0].dwHighDateTime << 32) | times[0].dwLowDateTime)}
while True:
    capacity = Capacity()
    capacity.length = ctypes.sizeof(capacity)
    if not kernel.GlobalMemoryStatusEx(ctypes.byref(capacity)):
        raise ctypes.WinError(ctypes.get_last_error())
    sample = {name: getattr(capacity, name) for name in (
        'totalPhysical', 'availablePhysical', 'totalPagefile', 'availablePagefile')}
    sample['hostReader'] = host_reader
    print(json.dumps(sample), flush=True)
    if '--stream' not in sys.argv:
        break
    time.sleep(0.5)
