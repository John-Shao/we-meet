"""OS parent-death containment for native children on Windows and Linux."""

import ctypes
import os
import signal
import sys
import threading


class ParentDeathJob:
    """Windows closes this parent's job handle on exit, killing its model child."""

    def __init__(self):
        self.handle = None
        self.lock = threading.Lock()
        if sys.platform == "win32":
            self.initialize_windows()
        elif not sys.platform.startswith("linux"):
            raise OSError("encoder_platform_unsupported")

    def initialize_windows(self):
        from ctypes import wintypes

        class BasicLimits(ctypes.Structure):
            _fields_ = [
                ("process_time", ctypes.c_longlong),
                ("job_time", ctypes.c_longlong),
                ("flags", wintypes.DWORD),
                ("minimum_working_set", ctypes.c_size_t),
                ("maximum_working_set", ctypes.c_size_t),
                ("active_process_limit", wintypes.DWORD),
                ("affinity", ctypes.c_size_t),
                ("priority", wintypes.DWORD),
                ("scheduling", wintypes.DWORD),
            ]

        class IoCounters(ctypes.Structure):
            _fields_ = [
                (name, ctypes.c_ulonglong)
                for name in (
                    "read_operations",
                    "write_operations",
                    "other_operations",
                    "read_bytes",
                    "write_bytes",
                    "other_bytes",
                )
            ]

        class ExtendedLimits(ctypes.Structure):
            _fields_ = [
                ("basic", BasicLimits),
                ("io", IoCounters),
                ("process_memory", ctypes.c_size_t),
                ("job_memory", ctypes.c_size_t),
                ("peak_process_memory", ctypes.c_size_t),
                ("peak_job_memory", ctypes.c_size_t),
            ]

        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        self.kernel.CreateJobObjectW.restype = wintypes.HANDLE
        self.kernel.SetInformationJobObject.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
        ]
        self.kernel.SetInformationJobObject.restype = wintypes.BOOL
        self.kernel.AssignProcessToJobObject.argtypes = [
            wintypes.HANDLE,
            wintypes.HANDLE,
        ]
        self.kernel.AssignProcessToJobObject.restype = wintypes.BOOL
        self.kernel.OpenProcess.argtypes = [
            wintypes.DWORD,
            wintypes.BOOL,
            wintypes.DWORD,
        ]
        self.kernel.OpenProcess.restype = wintypes.HANDLE
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.CloseHandle.restype = wintypes.BOOL
        self.handle = self.kernel.CreateJobObjectW(None, None)
        if not self.handle:
            raise OSError("encoder_job_unavailable")
        limits = ExtendedLimits()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
        if not self.kernel.SetInformationJobObject(
            self.handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)
        ):
            self.close()
            raise OSError("encoder_job_unavailable")

    def spawn(self, args, **kwargs):
        if sys.platform == "win32":
            from voiceprint.windows_process import WindowsJobProcess

            return WindowsJobProcess(args, job=self, **kwargs)
        import subprocess

        return subprocess.Popen(args, **kwargs)  # noqa: S603 -- Fixed module in caller.

    def close(self):
        with self.lock:
            handle = self.handle
            self.handle = None
        if handle is not None:
            self.kernel.CloseHandle(handle)


def contain_parent_exit(expected_parent):
    """Linux SIGKILL is delivered by the kernel even while native code holds the GIL."""
    if type(expected_parent) is not int or expected_parent <= 0:
        raise OSError("encoder_parent_invalid")
    if sys.platform == "win32":
        # The venv launcher may introduce an intermediate parent. Its job was
        # assigned while suspended, so the actual interpreter inherits it.
        from ctypes import wintypes

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        kernel.IsProcessInJob.argtypes = [
            wintypes.HANDLE,
            wintypes.HANDLE,
            ctypes.POINTER(wintypes.BOOL),
        ]
        kernel.IsProcessInJob.restype = wintypes.BOOL
        contained = wintypes.BOOL()
        if (
            not kernel.IsProcessInJob(
                kernel.GetCurrentProcess(), None, ctypes.byref(contained)
            )
            or not contained.value
        ):
            raise OSError("encoder_parent_invalid")
        return
    if sys.platform.startswith("linux"):
        libc = ctypes.CDLL(None, use_errno=True)
        libc.prctl.argtypes = [
            ctypes.c_int,
            ctypes.c_ulong,
            ctypes.c_ulong,
            ctypes.c_ulong,
            ctypes.c_ulong,
        ]
        libc.prctl.restype = ctypes.c_int
        if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
            raise OSError("encoder_parent_invalid")
    if os.getppid() != expected_parent:
        raise OSError("encoder_parent_invalid")
