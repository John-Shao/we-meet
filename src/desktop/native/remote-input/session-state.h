#pragma once
#include <wtsapi32.h>
#include <VersionHelpers.h>

#pragma comment(lib, "wtsapi32.lib")

namespace rc {
enum class DesktopSession { Unlocked, Locked, Disconnected, Unknown, Unsupported };
constexpr bool sessionAllowsInput(ULONG level,DWORD expected,DWORD actual,WTS_CONNECTSTATE_CLASS state,LONG flags) {
    return level==1 && expected==actual && state==WTSActive && flags==WTS_SESSIONSTATE_UNLOCK;
}
static_assert(sessionAllowsInput(1,1,1,WTSActive,WTS_SESSIONSTATE_UNLOCK));
static_assert(!sessionAllowsInput(1,1,1,WTSActive,WTS_SESSIONSTATE_LOCK));
static_assert(!sessionAllowsInput(1,1,1,WTSActive,LONG(WTS_SESSIONSTATE_UNKNOWN)));
static_assert(!sessionAllowsInput(1,1,1,WTSDisconnected,WTS_SESSIONSTATE_UNLOCK));
static_assert(!sessionAllowsInput(1,1,2,WTSActive,WTS_SESSIONSTATE_UNLOCK));
static_assert(!sessionAllowsInput(0,1,1,WTSActive,WTS_SESSIONSTATE_UNLOCK));

inline DesktopSession currentSessionState() {
    // The embedded manifest targets Windows 10/11. Older versions are rejected;
    // in particular Windows 7 has reversed lock flag semantics.
    if(!IsWindows10OrGreater())return DesktopSession::Unsupported;
    DWORD session=0;
    if(!ProcessIdToSessionId(GetCurrentProcessId(),&session))return DesktopSession::Unknown;
    LPWSTR buffer=nullptr;DWORD size=0;
    if(!WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE,session,WTSSessionInfoEx,&buffer,&size))return DesktopSession::Unknown;
    DesktopSession result=DesktopSession::Unknown;
    if(buffer && size>=sizeof(WTSINFOEXW)) {
        const auto* info=reinterpret_cast<const WTSINFOEXW*>(buffer);
        const auto& value=info->Data.WTSInfoExLevel1;
        if(sessionAllowsInput(info->Level,session,value.SessionId,value.SessionState,value.SessionFlags))result=DesktopSession::Unlocked;
        else if(info->Level==1 && value.SessionId==session) {
            if(value.SessionState!=WTSActive)result=DesktopSession::Disconnected;
            else if(value.SessionFlags==WTS_SESSIONSTATE_LOCK)result=DesktopSession::Locked;
        }
    }
    WTSFreeMemory(buffer);return result;
}
inline const char* sessionStateName(DesktopSession state) {
    switch(state) {
    case DesktopSession::Unlocked:return "unlocked";
    case DesktopSession::Locked:return "locked";
    case DesktopSession::Disconnected:return "disconnected";
    case DesktopSession::Unsupported:return "unsupported";
    default:return "unknown";
    }
}
}
