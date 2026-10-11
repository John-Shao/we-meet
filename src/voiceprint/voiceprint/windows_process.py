"""Atomic Windows job attachment, limited to this fixed local piped subprocess.

Python 3.13 Popen supports handle_list, but not PROC_THREAD_ATTRIBUTE_JOB_LIST.
Retain its pipe/handle/wait ownership while overriding only process creation.
"""

import ctypes
import os
import subprocess
import sys


class WindowsJobProcess(subprocess.Popen):
    def __init__(self, args, *, job, **kwargs):
        self.job = job
        super().__init__(args, **kwargs)

    def _execute_child(
        self,
        args,
        executable,
        preexec_fn,
        close_fds,
        pass_fds,
        cwd,
        env,
        startupinfo,
        creationflags,
        shell,
        p2cread,
        p2cwrite,
        c2pread,
        c2pwrite,
        errread,
        errwrite,
        *unused,
    ):
        # This is deliberately not a generic alternative process launcher.
        if (
            sys.platform != "win32"
            or executable is not None
            or preexec_fn
            or pass_fds
            or env is not None
            or startupinfo is not None
            or shell
            or not close_fds
            or not isinstance(args, list)
            or args[0] != sys.executable
            or -1 in (p2cread, c2pwrite, errwrite)
        ):
            raise OSError("encoder_configuration_invalid")
        try:
            process, thread, pid = create_in_job(
                args,
                os.fsdecode(cwd) if cwd is not None else None,
                creationflags,
                (p2cread, c2pwrite, errwrite),
                self.job,
            )
        finally:
            self._close_pipe_fds(
                p2cread, p2cwrite, c2pread, c2pwrite, errread, errwrite
            )
        self._child_created = True
        self._handle = subprocess.Handle(process)
        self.pid = pid
        self.job.kernel.CloseHandle(thread)


def create_in_job(args, cwd, flags, handles, job):
    from ctypes import wintypes

    class StartupInfo(ctypes.Structure):
        _fields_ = [
            ("size", wintypes.DWORD),
            ("reserved", wintypes.LPWSTR),
            ("desktop", wintypes.LPWSTR),
            ("title", wintypes.LPWSTR),
            ("x", wintypes.DWORD),
            ("y", wintypes.DWORD),
            ("width", wintypes.DWORD),
            ("height", wintypes.DWORD),
            ("chars_x", wintypes.DWORD),
            ("chars_y", wintypes.DWORD),
            ("fill", wintypes.DWORD),
            ("flags", wintypes.DWORD),
            ("show", wintypes.WORD),
            ("reserved_size", wintypes.WORD),
            ("reserved_bytes", ctypes.c_void_p),
            ("stdin", wintypes.HANDLE),
            ("stdout", wintypes.HANDLE),
            ("stderr", wintypes.HANDLE),
        ]

    class ExtendedStartup(ctypes.Structure):
        _fields_ = [("startup", StartupInfo), ("attributes", ctypes.c_void_p)]

    class ProcessInfo(ctypes.Structure):
        _fields_ = [
            ("process", wintypes.HANDLE),
            ("thread", wintypes.HANDLE),
            ("pid", wintypes.DWORD),
            ("tid", wintypes.DWORD),
        ]

    kernel = job.kernel
    kernel.InitializeProcThreadAttributeList.argtypes = [
        ctypes.c_void_p,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.POINTER(ctypes.c_size_t),
    ]
    kernel.InitializeProcThreadAttributeList.restype = wintypes.BOOL
    kernel.UpdateProcThreadAttribute.argtypes = [
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.c_size_t,
        ctypes.c_void_p,
        ctypes.c_size_t,
        ctypes.c_void_p,
        ctypes.c_void_p,
    ]
    kernel.UpdateProcThreadAttribute.restype = wintypes.BOOL
    kernel.DeleteProcThreadAttributeList.argtypes = [ctypes.c_void_p]
    kernel.DeleteProcThreadAttributeList.restype = None
    kernel.CreateProcessW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.LPWSTR,
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.BOOL,
        wintypes.DWORD,
        ctypes.c_void_p,
        wintypes.LPCWSTR,
        ctypes.POINTER(ExtendedStartup),
        ctypes.POINTER(ProcessInfo),
    ]
    kernel.CreateProcessW.restype = wintypes.BOOL
    size = ctypes.c_size_t()
    kernel.InitializeProcThreadAttributeList(None, 2, 0, ctypes.byref(size))
    if not 0 < size.value <= 65536:
        raise OSError("encoder_job_unavailable")
    attributes = ctypes.create_string_buffer(size.value)
    if not kernel.InitializeProcThreadAttributeList(
        attributes, 2, 0, ctypes.byref(size)
    ):
        raise OSError("encoder_job_unavailable")
    try:
        std_handles = (wintypes.HANDLE * 3)(*(int(handle) for handle in handles))
        jobs = (wintypes.HANDLE * 1)(job.handle)
        for attribute, values in ((0x20002, std_handles), (0x2000D, jobs)):
            if not kernel.UpdateProcThreadAttribute(
                attributes, 0, attribute, values, ctypes.sizeof(values), None, None
            ):
                raise OSError("encoder_job_unavailable")
        startup = ExtendedStartup()
        startup.startup.size = ctypes.sizeof(startup)
        startup.startup.flags = 0x0100  # STARTF_USESTDHANDLES.
        startup.startup.stdin, startup.startup.stdout, startup.startup.stderr = (
            std_handles
        )
        startup.attributes = ctypes.addressof(attributes)
        info = ProcessInfo()
        command = ctypes.create_unicode_buffer(subprocess.list2cmdline(args))
        sys.audit("subprocess.Popen", args[0], command.value, cwd, None)
        if not kernel.CreateProcessW(
            args[0],
            command,
            None,
            None,
            True,
            flags | 0x00080000,
            None,
            cwd,
            ctypes.byref(startup),
            ctypes.byref(info),
        ):
            raise OSError("encoder_job_unavailable")
        return info.process, info.thread, info.pid
    finally:
        kernel.DeleteProcThreadAttributeList(attributes)
