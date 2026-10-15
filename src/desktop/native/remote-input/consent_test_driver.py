"""Test-only HWND driver. Addresses a freshly spawned test helper by exact PID.

This is OS-level test automation, not proof of human consent or a production IPC.
It cannot click an arbitrary application or a non-test remote-control prompt.
"""
import ctypes
from ctypes import wintypes
import sys

LABEL = "We-Meet native consent test"
user = ctypes.WinDLL("user32", use_last_error=True)
user.GetDlgItem.argtypes = [wintypes.HWND, ctypes.c_int]
user.GetDlgItem.restype = wintypes.HWND
user.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user.IsWindowVisible.argtypes = [wintypes.HWND]
user.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user.SendMessageW.restype = wintypes.LPARAM
user.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
CALLBACK = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user.EnumWindows.argtypes = [CALLBACK, wintypes.LPARAM]
user.EnumChildWindows.argtypes = [wintypes.HWND, CALLBACK, wintypes.LPARAM]


def text(window):
    value = ctypes.create_unicode_buffer(2048)
    user.GetWindowTextW(window, value, len(value))
    return value.value


def window_for(pid):
    windows = []

    @CALLBACK
    def visit(window, _):
        owner = wintypes.DWORD()
        user.GetWindowThreadProcessId(window, ctypes.byref(owner))
        name = ctypes.create_unicode_buffer(128)
        user.GetClassNameW(window, name, len(name))
        if owner.value == pid and name.value == "WeMeetRemoteControlTrustedUi" and user.IsWindowVisible(window):
            windows.append(window)
        return True

    user.EnumWindows(visit, 0)
    if len(windows) != 1:
        raise RuntimeError("Expected one visible test helper consent surface")
    labels = []

    @CALLBACK
    def child(window, _):
        labels.append(text(window))
        return True

    user.EnumChildWindows(windows[0], child, 0)
    if not any(LABEL in label for label in labels):
        raise RuntimeError("Refusing to operate a non-test consent surface")
    return windows[0]


def approve(pid):
    button = user.GetDlgItem(window_for(pid), 2)
    if text(button) != "允许本次控制":
        raise RuntimeError("Expected a pending consent, not an active control bar")
    user.SendMessageW(button, 0xF5, 0, 0)  # BM_CLICK, no system input injection


if __name__ == "__main__":
    approve(int(sys.argv[1]))
