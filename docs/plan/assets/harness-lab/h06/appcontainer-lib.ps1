Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AC3 {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX; public int dwY; public int dwXSize; public int dwYSize;
        public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
        public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
        public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    static extern int CreateAppContainerProfile(string name, string displayName, string description, IntPtr capabilities, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    static extern int GetAppContainerFolderPath(string sid, out IntPtr path);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    public static extern int DeleteAppContainerProfile(string name);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    static extern bool ConvertSidToStringSid(IntPtr sid, out string str);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    static extern bool ConvertStringSidToSid(string str, out IntPtr sid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreateProcess(string app, string commandLine, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")]
    static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr p, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll")] static extern bool DeleteProcThreadAttributeList(IntPtr l);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
    [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr p);

    public static int CreateProfile(string name, out string sidString, out string folder) {
        sidString = null; folder = null;
        IntPtr sid;
        int hr = CreateAppContainerProfile(name, name, "wemeet h06 sandbox", IntPtr.Zero, 0, out sid);
        if (hr != 0) return hr;
        ConvertSidToStringSid(sid, out sidString);
        IntPtr path;
        int hr2 = GetAppContainerFolderPath(sidString, out path);
        if (hr2 != 0) return hr2;
        folder = Marshal.PtrToStringUni(path);
        CoTaskMemFree(path);
        return 0;
    }
    public static bool Run(string sidString, string commandLine, string cwd, out uint exitCode, out string error) {
        exitCode = 0; error = null;
        IntPtr sid;
        if (!ConvertStringSidToSid(sidString, out sid)) { error = "sid convert failed"; return false; }
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        IntPtr list = Marshal.AllocHGlobal(size);
        InitializeProcThreadAttributeList(list, 1, 0, ref size);
        SECURITY_CAPABILITIES caps = new SECURITY_CAPABILITIES();
        caps.AppContainerSid = sid; caps.Capabilities = IntPtr.Zero; caps.CapabilityCount = 0; caps.Reserved = 0;
        IntPtr capsPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
        Marshal.StructureToPtr(caps, capsPtr, false);
        UpdateProcThreadAttribute(list, 0, (IntPtr)0x00020009, capsPtr, (IntPtr)Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)), IntPtr.Zero, IntPtr.Zero);
        STARTUPINFOEX si = new STARTUPINFOEX();
        si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
        si.lpAttributeList = list;
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION jobInfo = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        jobInfo.BasicLimitInformation.LimitFlags = 0x8 | 0x2000;
        jobInfo.BasicLimitInformation.ActiveProcessLimit = 1;
        IntPtr jobInfoPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
        Marshal.StructureToPtr(jobInfo, jobInfoPtr, false);
        bool jobSet = SetInformationJobObject(job, 9, jobInfoPtr, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
        if (!jobSet) { error = "SetInformationJobObject failed " + Marshal.GetLastWin32Error(); return false; }
        PROCESS_INFORMATION pi;
        bool ok = CreateProcess(null, commandLine, IntPtr.Zero, IntPtr.Zero, false, 0x00080000 | 0x000400 | 0x4, IntPtr.Zero, cwd, ref si, out pi);
        if (!ok) { error = "CreateProcess failed " + Marshal.GetLastWin32Error(); return false; }
        bool assigned = AssignProcessToJobObject(job, pi.hProcess);
        if (!assigned) {
            error = "AssignProcessToJobObject failed " + Marshal.GetLastWin32Error();
            TerminateProcess(pi.hProcess, 1);
        } else {
            ResumeThread(pi.hThread);
        }
        uint wait = WaitForSingleObject(pi.hProcess, 20000);
        if (wait == 0x102) {
            TerminateJobObject(job, 1);
            TerminateProcess(pi.hProcess, 1);
            error = "container process timed out";
        }
        GetExitCodeProcess(pi.hProcess, out exitCode);
        CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
        CloseHandle(job);
        Marshal.FreeHGlobal(jobInfoPtr);
        DeleteProcThreadAttributeList(list);
        Marshal.FreeHGlobal(list); Marshal.FreeHGlobal(capsPtr); LocalFree(sid);
        return true;
    }
}
"@
