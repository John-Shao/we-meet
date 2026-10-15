#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <bcrypt.h>
#include <shellapi.h>
#include <shellscalingapi.h>
#include <atomic>
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#include "protocol.h"
#include "trusted-ui.h"

#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "gdi32.lib")
#pragma comment(lib, "shcore.lib")

namespace {
constexpr ULONG_PTR InputTag = 0x574d5243;
constexpr size_t KeyCount = 512;
constexpr size_t ButtonBase = KeyCount;
constexpr size_t CandidateCount = KeyCount + 3;
struct Ledger {
    uint32_t magic;
    volatile LONG gate; // one-way close until a parent-authorized fresh Arm
    volatile LONG cleanup; // 0 pending, 1 clean, -1 failed, -2 uncertain
    volatile LONG active;
    volatile LONG candidates[CandidateCount];
    volatile LONG unicodeCandidate; // UTF-16 code unit + 1, recorded before pair
    volatile LONG64 workerBeat, parentBeat;
};
std::mutex outputMutex;
uint64_t now() { return GetTickCount64(); }
std::string hex(const uint8_t* p, size_t n) {
    std::ostringstream out;
    out << std::hex << std::setfill('0');
    for(size_t i=0;i<n;++i) out << std::setw(2) << unsigned(p[i]);
    return out.str();
}
void reply(const std::string& body) {
    std::lock_guard<std::mutex> lock(outputMutex);
    std::cout << body << '\n' << std::flush;
}
bool defaultDesktop() {
    HDESK desk=OpenInputDesktop(0,FALSE,DESKTOP_READOBJECTS);
    if(!desk) return false;
    wchar_t name[256]{}; DWORD needed=0;
    bool ok=GetUserObjectInformationW(desk,UOI_NAME,name,sizeof(name),&needed) && wcscmp(name,L"Default")==0;
    CloseDesktop(desk);
    return ok;
}
bool emptyLedger(Ledger* l) {
    if(InterlockedCompareExchange(&l->unicodeCandidate,0,0))return false;
    for(size_t i=0;i<CandidateCount;++i) if(InterlockedCompareExchange(&l->candidates[i],0,0)) return false;
    return true;
}
bool release(Ledger* l) {
    InterlockedExchange(&l->gate,0);
    if(!defaultDesktop()) { InterlockedExchange(&l->cleanup,-2); return false; }
    bool ok=true;
    LONG unicode=InterlockedCompareExchange(&l->unicodeCandidate,0,0);
    if(unicode) {
        INPUT e{};e.type=INPUT_KEYBOARD;e.ki.wScan=WORD(unicode-1);
        e.ki.dwFlags=KEYEVENTF_UNICODE|KEYEVENTF_KEYUP;e.ki.dwExtraInfo=InputTag;
        if(SendInput(1,&e,sizeof(e))==1 && defaultDesktop())InterlockedExchange(&l->unicodeCandidate,0);
        else ok=false;
    }
    for(size_t i=0;i<CandidateCount;++i) {
        if(!InterlockedCompareExchange(&l->candidates[i],0,0)) continue;
        INPUT e{};
        if(i<KeyCount) {
            e.type=INPUT_KEYBOARD; e.ki.wScan=WORD(i%256);
            e.ki.dwFlags=KEYEVENTF_SCANCODE|KEYEVENTF_KEYUP|(i>=256?KEYEVENTF_EXTENDEDKEY:0);
            e.ki.dwExtraInfo=InputTag;
        } else {
            e.type=INPUT_MOUSE;
            e.mi.dwFlags=i==ButtonBase?MOUSEEVENTF_LEFTUP:i==ButtonBase+1?MOUSEEVENTF_RIGHTUP:MOUSEEVENTF_MIDDLEUP;
            e.mi.dwExtraInfo=InputTag;
        }
        if(SendInput(1,&e,sizeof(e))==1 && defaultDesktop()) InterlockedExchange(&l->candidates[i],0);
        else ok=false;
    }
    InterlockedExchange(&l->cleanup,ok?1:-1);
    return ok;
}

// Guardian receives only inherited handles, not commands, keys, URLs or code.
// It survives parent exit long enough to terminate the worker and release the
// conservative write-ahead ledger. It never injects down/move/text.
int guardian(HANDLE mapping,HANDLE worker,HANDLE parent,HANDLE report) {
    auto* l=static_cast<Ledger*>(MapViewOfFile(mapping,FILE_MAP_ALL_ACCESS,0,0,sizeof(Ledger)));
    if(!l || l->magic!=rc::Magic) return 2;
    auto finish=[&](int code){
        std::string message="{\"event\":\"guardianClosed\",\"cleanup\":"+std::to_string(l->cleanup)+"}\n";
        DWORD written=0;WriteFile(report,message.data(),DWORD(message.size()),&written,nullptr);
        UnmapViewOfFile(l);CloseHandle(mapping);CloseHandle(worker);CloseHandle(parent);CloseHandle(report);
        return code;
    };
    for(;;) {
        const auto t=now();
        bool exited=WaitForSingleObject(worker,0)==WAIT_OBJECT_0;
        bool parentGone=WaitForSingleObject(parent,0)==WAIT_OBJECT_0;
        bool stale=t-static_cast<uint64_t>(InterlockedCompareExchange64(&l->workerBeat,0,0))>rc::WatchdogMs;
        bool parentStale=t-static_cast<uint64_t>(InterlockedCompareExchange64(&l->parentBeat,0,0))>rc::WatchdogMs;
        if(exited || parentGone || stale || parentStale) {
            InterlockedExchange(&l->gate,0);
            if(!exited) {
                if(!TerminateProcess(worker,3) || WaitForSingleObject(worker,500)!=WAIT_OBJECT_0) {
                    InterlockedExchange(&l->cleanup,-1); return finish(3);
                }
            }
            // A previous uncertain cleanup is sticky, even if desktop returned.
            if(InterlockedCompareExchange(&l->cleanup,0,0)<0) return finish(4);
            const bool ok=release(l);
            return finish(ok?0:4);
        }
        Sleep(20);
    }
}

struct Monitor {
    RECT rect;std::wstring name,devicePath;DWORD rotation=0;UINT dpiX=0,dpiY=0;
    bool operator==(const Monitor& other) const {
        return EqualRect(&rect,&other.rect) && name==other.name && devicePath==other.devicePath &&
            rotation==other.rotation && dpiX==other.dpiX && dpiY==other.dpiY;
    }
};
std::wstring displayPath(const std::wstring& sourceName) {
    UINT32 pathCount=0,modeCount=0;
    if(GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS,&pathCount,&modeCount)!=ERROR_SUCCESS || pathCount>128 || modeCount>512)return {};
    std::vector<DISPLAYCONFIG_PATH_INFO> paths(pathCount);std::vector<DISPLAYCONFIG_MODE_INFO> modes(modeCount);
    if(QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS,&pathCount,paths.data(),&modeCount,modes.data(),nullptr)!=ERROR_SUCCESS)return {};
    std::wstring found;unsigned matches=0;
    for(UINT32 i=0;i<pathCount;++i) {
        DISPLAYCONFIG_SOURCE_DEVICE_NAME source{};
        source.header={DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,sizeof(source),paths[i].sourceInfo.adapterId,paths[i].sourceInfo.id};
        if(DisplayConfigGetDeviceInfo(&source.header)!=ERROR_SUCCESS || sourceName!=source.viewGdiDeviceName)continue;
        ++matches;
        DISPLAYCONFIG_TARGET_DEVICE_NAME target{};
        target.header={DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,sizeof(target),paths[i].targetInfo.adapterId,paths[i].targetInfo.id};
        if(DisplayConfigGetDeviceInfo(&target.header)==ERROR_SUCCESS)found=target.monitorDevicePath;
    }
    // Mirrored outputs with one GDI source are ambiguous for a single-monitor grant.
    return matches==1?found:std::wstring{};
}
std::vector<Monitor> monitors() {
    std::vector<Monitor> result;
    EnumDisplayMonitors(nullptr,nullptr,[](HMONITOR h,HDC,LPRECT,LPARAM data)->BOOL {
        MONITORINFOEXW mi{};mi.cbSize=sizeof(mi);
        if(GetMonitorInfoW(h,&mi)) {
            Monitor monitor{};monitor.rect=mi.rcMonitor;monitor.name=mi.szDevice;monitor.devicePath=displayPath(monitor.name);
            DEVMODEW mode{};mode.dmSize=sizeof(mode);
            if(EnumDisplaySettingsExW(mi.szDevice,ENUM_CURRENT_SETTINGS,&mode,0))monitor.rotation=mode.dmDisplayOrientation*90;
            GetDpiForMonitor(h,MDT_EFFECTIVE_DPI,&monitor.dpiX,&monitor.dpiY);
            reinterpret_cast<std::vector<Monitor>*>(data)->push_back(monitor);
        }
        return TRUE;
    },reinterpret_cast<LPARAM>(&result));
    return result;
}
std::optional<Monitor> selectedMonitor(const rc::Arm& a) {
    std::optional<Monitor> result;
    for(const auto& m:monitors()) if(m.rect.left==a.left && m.rect.top==a.top &&
        m.rect.right-m.rect.left==a.width && m.rect.bottom-m.rect.top==a.height) {
        if(result || m.devicePath.empty() || !m.dpiX || !m.dpiY)return {};
        result=m;
    }
    return result;
}
std::string jsonText(const std::wstring& value) {
    std::ostringstream out;out<<'"'<<std::hex<<std::setfill('0');
    for(wchar_t unit:value)out<<"\\u"<<std::setw(4)<<static_cast<unsigned>(unit);
    out<<'"';return out.str();
}
// Scan-code allowlist: printable keys, editing/navigation, modifiers and F1..F12.
// No power/sleep/application launch keys; Windows key combinations are further
// limited by the caller's published key map and the stateful forbidden chords.
bool allowedScan(uint32_t code,bool extended) {
    if(extended) switch(code) {
        case 0x1c: case 0x1d: case 0x35: case 0x38: case 0x47: case 0x48:
        case 0x49: case 0x4b: case 0x4d: case 0x4f: case 0x50: case 0x51:
        case 0x52: case 0x53: return true;
        default:return false;
    }
    return (code>=1 && code<=0x53 && code!=0x54) || code==0x57 || code==0x58;
}
class Runtime {
public:
    Runtime():parent_(GetStdHandle(STD_INPUT_HANDLE)) {
        SECURITY_ATTRIBUTES sa{sizeof(sa),nullptr,TRUE};
        mapping_=CreateFileMappingW(INVALID_HANDLE_VALUE,&sa,PAGE_READWRITE,0,sizeof(Ledger),nullptr);
        if(!mapping_) throw std::runtime_error("mapping_failed");
        ledger_=static_cast<Ledger*>(MapViewOfFile(mapping_,FILE_MAP_ALL_ACCESS,0,0,sizeof(Ledger)));
        if(!ledger_) throw std::runtime_error("mapping_failed");
        ZeroMemory(ledger_,sizeof(Ledger));ledger_->magic=rc::Magic;ledger_->cleanup=1;
        ledger_->workerBeat=ledger_->parentBeat=now();
        if(BCryptOpenAlgorithmProvider(&ecdsa_,BCRYPT_ECDSA_P256_ALGORITHM,nullptr,0)<0) throw std::runtime_error("crypto_failed");
    }
    ~Runtime() {
        running_=false;
        if(watch_.joinable())watch_.join();
        if(hookThread_.joinable()){PostThreadMessageW(hookId_,WM_QUIT,0,0);hookThread_.join();}
        {std::lock_guard<std::mutex> lock(mutex_);close("exit",false);}
        if(key_)BCryptDestroyKey(key_);
        if(ecdsa_)BCryptCloseAlgorithmProvider(ecdsa_,0);
        // Guardian owns its inherited mapping handle until this process exits.
        if(ledger_)UnmapViewOfFile(ledger_);
        if(mapping_)CloseHandle(mapping_);
        if(guard_)CloseHandle(guard_);
    }
    void start(DWORD parentPid) {
        HANDLE worker=nullptr,parent=nullptr,report=nullptr;
        if(!DuplicateHandle(GetCurrentProcess(),GetCurrentProcess(),GetCurrentProcess(),&worker,
            SYNCHRONIZE|PROCESS_TERMINATE,TRUE,0)) throw std::runtime_error("worker_handle_failed");
        parent=OpenProcess(SYNCHRONIZE,TRUE,parentPid);
        if(!parent)throw std::runtime_error("parent_handle_failed");
        if(!DuplicateHandle(GetCurrentProcess(),GetStdHandle(STD_OUTPUT_HANDLE),GetCurrentProcess(),&report,
            0,TRUE,DUPLICATE_SAME_ACCESS))throw std::runtime_error("report_handle_failed");
        wchar_t path[32768]{};GetModuleFileNameW(nullptr,path,32768);
        std::wstring command=L"\""+std::wstring(path)+L"\" --guardian "+
            std::to_wstring(reinterpret_cast<uintptr_t>(mapping_))+L" "+
            std::to_wstring(reinterpret_cast<uintptr_t>(worker))+L" "+
            std::to_wstring(reinterpret_cast<uintptr_t>(parent))+L" "+std::to_wstring(reinterpret_cast<uintptr_t>(report));
        SIZE_T size=0;InitializeProcThreadAttributeList(nullptr,1,0,&size);
        std::vector<uint8_t> attributes(size);
        STARTUPINFOEXW si{};si.StartupInfo.cb=sizeof(si);
        si.lpAttributeList=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
        if(!InitializeProcThreadAttributeList(si.lpAttributeList,1,0,&size))throw std::runtime_error("spawn_failed");
        HANDLE handles[]={mapping_,worker,parent,report};
        bool ok=UpdateProcThreadAttribute(si.lpAttributeList,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,handles,sizeof(handles),nullptr,nullptr)!=0;
        PROCESS_INFORMATION pi{};
        ok=ok && CreateProcessW(path,command.data(),nullptr,nullptr,TRUE,CREATE_NO_WINDOW|EXTENDED_STARTUPINFO_PRESENT,nullptr,nullptr,&si.StartupInfo,&pi);
        DeleteProcThreadAttributeList(si.lpAttributeList);CloseHandle(worker);CloseHandle(parent);CloseHandle(report);
        if(!ok)throw std::runtime_error("guardian_failed");
        CloseHandle(pi.hThread);guard_=pi.hProcess;
        instance_=this;
        hookThread_=std::thread([this]{
            hookId_=GetCurrentThreadId();
            MSG msg{};PeekMessageW(&msg,nullptr,0,0,PM_NOREMOVE);
            HHOOK keyboard=SetWindowsHookExW(WH_KEYBOARD_LL,keyboardHook,GetModuleHandleW(nullptr),0);
            HHOOK mouse=SetWindowsHookExW(WH_MOUSE_LL,mouseHook,GetModuleHandleW(nullptr),0);
            bool hotkey=RegisterHotKey(nullptr,1,MOD_CONTROL|MOD_ALT|MOD_SHIFT|MOD_NOREPEAT,VK_F10)!=0;
            bool uiReady=ui_.initialize([this](TrustedUi::Event event,const rc::Consent& proposal){
                std::lock_guard<std::mutex> lock(uiEventsMutex_);
                if(uiEvents_.size()<32)uiEvents_.push_back({event,proposal});
                else emergencyStop_=true;
            });
            hooksReady_=keyboard && mouse && hotkey && uiReady;
            hooksStarted_=true;
            while(GetMessageW(&msg,nullptr,0,0)>0) {
                if(msg.message==WM_HOTKEY) {emergencyStop_=true;InterlockedExchange(&ledger_->gate,0);}
                if(msg.message==TrustedUi::Update){ui_.drain();continue;}
                TranslateMessage(&msg);DispatchMessageW(&msg);
            }
            ui_.dispose();
            if(keyboard)UnhookWindowsHookEx(keyboard);
            if(mouse)UnhookWindowsHookEx(mouse);
            if(hotkey)UnregisterHotKey(nullptr,1);
        });
        while(!hooksStarted_)Sleep(1);
        watch_=std::thread([this]{
            while(running_) {
                std::this_thread::sleep_for(std::chrono::milliseconds(20));
                std::lock_guard<std::mutex> lock(mutex_);
                InterlockedExchange64(&ledger_->workerBeat,now());
                std::deque<UiEvent> events;
                {std::lock_guard<std::mutex> uiLock(uiEventsMutex_);events.swap(uiEvents_);}
                for(const auto& event:events)uiEvent(event);
                if(WaitForSingleObject(guard_,0)!=WAIT_TIMEOUT) {close("guardian_lost");return;}
                if(emergencyStop_.exchange(false)){close("emergency_stop");continue;}
                if(consentPending_ && now()>=consentExpires_){close("consent_expired");continue;}
                if(consentApproved_ && now()>=consentExpires_){close("consent_expired");continue;}
                if(!active_)continue;
                if(!defaultDesktop()) {InterlockedExchange(&ledger_->cleanup,-2);close("desktop_uncertain");}
                else if(localStop_.exchange(false))close("local_takeover",true,false,TrustedUi::Mode::Paused);
                else if(!ui_.ready())close("native_ui_unavailable");
                else if(now()>=deadline_)close("lease_expired");
                else if(now()-controllerBeat_>=3000)close("controller_timeout");
                else if(now()-displayChecked_>=500) {
                    displayChecked_=now();auto current=selectedMonitor(arm_);
                    if(!current || !(*current==consentMonitor_))close("display_changed");
                }
            }
        });
        reply("{\"event\":\"hello\",\"version\":1,\"pid\":"+std::to_string(GetCurrentProcessId())+
            ",\"guardianPid\":"+std::to_string(GetProcessId(guard_))+",\"ready\":"+(hooksReady_?"true":"false")+"}");
    }
    void handle(rc::Command cmd,const std::vector<uint8_t>& data) {
        std::lock_guard<std::mutex> lock(mutex_);
        if(cmd==rc::Command::ParentAlive && data.empty()){InterlockedExchange64(&ledger_->parentBeat,now());return;}
        if(cmd==rc::Command::Close && data.empty()){close("parent_stop");return;}
        if(cmd==rc::Command::Suspend && data.empty() && consentApproved_){close("capture_suspended",true,true,TrustedUi::Mode::Waiting);return;}
        if(cmd==rc::Command::Pause && data.empty() && (active_ || consentApproved_ || consentUsed_)) {
            close("parent_pause",true,false,TrustedUi::Mode::Paused);return;
        }
        if(cmd==rc::Command::Consent && data.size()==sizeof(rc::Consent)){consent(data);return;}
        if(cmd==rc::Command::Hello && data.empty()) {
            std::ostringstream out;out<<"{\"event\":\"displays\",\"displays\":[";
            bool first=true;for(const auto& m:monitors()) {
                if(!first)out<<",";first=false;
                out<<"{\"left\":"<<m.rect.left<<",\"top\":"<<m.rect.top<<",\"width\":"<<m.rect.right-m.rect.left
                   <<",\"height\":"<<m.rect.bottom-m.rect.top<<",\"deviceName\":"<<jsonText(m.name)
                   <<",\"devicePath\":"<<jsonText(m.devicePath)<<",\"rotation\":"<<m.rotation
                   <<",\"dpiX\":"<<m.dpiX<<",\"dpiY\":"<<m.dpiY<<"}";
            }out<<"]}";reply(out.str());return;
        }
        if(cmd==rc::Command::Arm && data.size()==sizeof(rc::Arm)){arm(data);return;}
        if(cmd==rc::Command::Challenge && data.empty() && active_){challenge();return;}
        if(cmd==rc::Command::Lease && data.size()==4 && active_) {
            uint32_t ms=0;memcpy(&ms,data.data(),4);
            if(ms==0 || ms>15000){close("invalid_lease");return;}
            deadline_=now()+ms;return;
        }
        if(cmd==rc::Command::Input && data.size()==sizeof(rc::Input)){input(data);return;}
        close("invalid_command");
    }
private:
    static Runtime* instance_;
    struct UiEvent {TrustedUi::Event event;rc::Consent proposal;};
    void uiEvent(const UiEvent& item) {
        if(memcmp(item.proposal.id,consent_.id,16))return;
        if(item.event==TrustedUi::Event::Shown) {
            if(consentPending_)reply("{\"event\":\"consentShown\",\"consentId\":\""+hex(consent_.id,16)+"\"}");return;
        }
        if(item.event==TrustedUi::Event::Allowed) {
            if(!consentPending_ || now()>=consentExpires_ || !defaultDesktop() || !ui_.ready()) {
                close("consent_expired");return;
            }
            consentPending_=false;consentApproved_=true;
            reply("{\"event\":\"consentAllowed\",\"consentId\":\""+hex(consent_.id,16)+"\"}");return;
        }
        if(item.event==TrustedUi::Event::Resume) {
            // Only a local button creates this event. It does not arm or renew
            // anything; main must obtain a fresh local consent and new epoch.
            reply("{\"event\":\"resumeRequested\",\"consentId\":\""+hex(consent_.id,16)+"\"}");return;
        }
        close(item.event==TrustedUi::Event::Expired?"consent_expired":
            item.event==TrustedUi::Event::Denied?"consent_denied":
            item.event==TrustedUi::Event::Stop?"local_stop":"native_ui_unavailable");
    }
    void consent(const std::vector<uint8_t>& data) {
        if(active_ || consentPending_ || consentApproved_ || !hooksReady_ || ledger_->cleanup<0 || !emptyLedger(ledger_)) {
            close("consent_denied");return;
        }
        rc::Consent proposal{};memcpy(&proposal,data.data(),sizeof(proposal));
        bool textOk=proposal.controller[0]!=0 && proposal.controller[159]==0;
        for(size_t i=0;i<159 && proposal.controller[i];++i) {
            const auto c=proposal.controller[i];
            if(c<32 || (c>=0x7f&&c<=0x9f) || (c>=0x202a&&c<=0x202e) || (c>=0x2066&&c<=0x2069))textOk=false;
            if(c>=0xd800&&c<=0xdbff) {const auto next=proposal.controller[++i];if(next<0xdc00||next>0xdfff)textOk=false;}
            else if(c>=0xdc00&&c<=0xdfff)textOk=false;
        }
        auto monitor=selectedMonitor(proposal.binding);
        if(!textOk || !proposal.timeoutMs || proposal.timeoutMs>60000 || !proposal.binding.epoch ||
           !defaultDesktop() || !monitor) {close("invalid_consent");return;}
        consentMonitor_=*monitor;
        consent_=proposal;consentPending_=true;consentApproved_=false;consentUsed_=false;
        consentExpires_=now()+proposal.timeoutMs;
        if(!ui_.present(proposal))close("native_ui_unavailable");
    }
    static LRESULT CALLBACK keyboardHook(int n,WPARAM w,LPARAM l) {
        if(n>=0 && instance_ && instance_->activeFlag_) {
            auto* e=reinterpret_cast<KBDLLHOOKSTRUCT*>(l);
            if(!(e->flags&LLKHF_INJECTED)) {instance_->localStop_=true;InterlockedExchange(&instance_->ledger_->gate,0);}
        }
        return CallNextHookEx(nullptr,n,w,l);
    }
    static LRESULT CALLBACK mouseHook(int n,WPARAM w,LPARAM l) {
        if(n>=0 && instance_ && instance_->activeFlag_) {
            auto* e=reinterpret_cast<MSLLHOOKSTRUCT*>(l);
            if(!(e->flags&LLMHF_INJECTED)) {instance_->localStop_=true;InterlockedExchange(&instance_->ledger_->gate,0);}
        }
        return CallNextHookEx(nullptr,n,w,l);
    }
    void close(const char* reason,bool emit=true,bool keepConsent=false,TrustedUi::Mode mode=TrustedUi::Mode::Hidden) {
        const bool was=active_;active_=false;activeFlag_=false;
        InterlockedExchange(&ledger_->active,0);InterlockedExchange(&ledger_->gate,0);
        if(ledger_->cleanup>=0)release(ledger_);
        challenges_.clear();
        if(!keepConsent){consentPending_=false;consentApproved_=false;}
        ui_.setMode(mode);
        if(emit)reply(std::string("{\"event\":\"closed\",\"reason\":\"")+reason+"\",\"wasActive\":"+
            (was?"true":"false")+",\"cleanup\":"+std::to_string(ledger_->cleanup)+"}");
    }
    void arm(const std::vector<uint8_t>& data) {
        if(active_ || !hooksReady_ || !consentApproved_ || now()>=consentExpires_ || !ui_.ready() || ledger_->cleanup<0 || !emptyLedger(ledger_) ||
           WaitForSingleObject(guard_,0)!=WAIT_TIMEOUT || !defaultDesktop()) {close("arm_denied");return;}
        rc::Arm a{};memcpy(&a,data.data(),sizeof(a));
        auto monitor=selectedMonitor(a);
        if(a.epoch==0 || a.leaseMs==0 || a.leaseMs>15000 || !monitor || !(*monitor==consentMonitor_)){close("invalid_binding");return;}
        const auto& approved=consent_.binding;
        if(memcmp(a.session,approved.session,16) || memcmp(a.share,approved.share,16) || a.epoch!=approved.epoch ||
           a.left!=approved.left || a.top!=approved.top || a.width!=approved.width || a.height!=approved.height ||
           memcmp(a.publicKey,approved.publicKey,64)) {close("consent_binding_mismatch");return;}
        if(consentUsed_ && !memcmp(a.generation,arm_.generation,16)){close("generation_reused");return;}
        struct PublicBlob {BCRYPT_ECCKEY_BLOB header;uint8_t xy[64];} blob{};
        blob.header={BCRYPT_ECDSA_PUBLIC_P256_MAGIC,32};memcpy(blob.xy,a.publicKey,64);
        BCRYPT_KEY_HANDLE key=nullptr;
        if(BCryptImportKeyPair(ecdsa_,nullptr,BCRYPT_ECCPUBLIC_BLOB,&key,reinterpret_cast<PUCHAR>(&blob),sizeof(blob),0)<0){close("invalid_key");return;}
        if(key_)BCryptDestroyKey(key_);key_=key;
        arm_=a;lastSeq_=lastHeartbeat_=0;deadline_=now()+a.leaseMs;controllerBeat_=now();
        rateWindow_=displayChecked_=now();rateCount_=textCount_=0;localStop_=false;
        if(!consentUsed_){consentExpires_=now()+1800000;consentUsed_=true;}
        if(!ui_.setMode(TrustedUi::Mode::Active)){close("native_ui_unavailable");return;}
        active_=true;activeFlag_=true;ledger_->cleanup=0;
        InterlockedExchange(&ledger_->active,1);InterlockedExchange(&ledger_->gate,1);
        challenge();reply("{\"event\":\"armed\"}");
    }
    struct Challenge {std::array<uint8_t,16> nonce;uint64_t expires;};
    void challenge() {
        challenges_.erase(std::remove_if(challenges_.begin(),challenges_.end(),[](auto& c){return c.expires<=now();}),challenges_.end());
        if(challenges_.size()>=4)return;
        Challenge c{};c.expires=now()+rc::ChallengeMs;
        if(BCryptGenRandom(nullptr,c.nonce.data(),16,BCRYPT_USE_SYSTEM_PREFERRED_RNG)<0){close("random_failed");return;}
        challenges_.push_back(c);
        reply("{\"event\":\"challenge\",\"nonce\":\""+hex(c.nonce.data(),16)+"\",\"ttlMs\":3000}");
    }
    bool verify(const rc::Input& e) {
        std::array<uint8_t,32> hash{};
        BCRYPT_ALG_HANDLE algorithm=nullptr;
        if(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0)return false;
        auto status=BCryptHash(algorithm,nullptr,0,reinterpret_cast<PUCHAR>(const_cast<rc::Input*>(&e)),640,hash.data(),32);
        BCryptCloseAlgorithmProvider(algorithm,0);
        return status>=0 && BCryptVerifySignature(key_,nullptr,hash.data(),32,const_cast<PUCHAR>(e.signature),64,0)>=0;
    }
    bool send(INPUT e) {
        if(!active_ || ledger_->gate!=1 || localStop_ || now()>=deadline_ || !ui_.ready() ||
            (e.type==INPUT_KEYBOARD && ui_.ownsForeground()))return false;
        if(!defaultDesktop()){InterlockedExchange(&ledger_->cleanup,-2);return false;}
        const bool ok=SendInput(1,&e,sizeof(e))==1;
        if(!defaultDesktop()){InterlockedExchange(&ledger_->cleanup,-2);return false;}
        return ok;
    }
    bool move(double x,double y) {
        int px=arm_.left+int(std::round(x*(arm_.width-1))),py=arm_.top+int(std::round(y*(arm_.height-1)));
        // The actual native HWND region is checked for every move/click/wheel.
        if(!ui_.allowsPointer(px,py))return false;
        int vx=GetSystemMetrics(SM_XVIRTUALSCREEN),vy=GetSystemMetrics(SM_YVIRTUALSCREEN);
        int vw=GetSystemMetrics(SM_CXVIRTUALSCREEN),vh=GetSystemMetrics(SM_CYVIRTUALSCREEN);
        if(vw<=1 || vh<=1)return false;
        INPUT e{};e.type=INPUT_MOUSE;e.mi.dwExtraInfo=InputTag;
        e.mi.dx=LONG(std::llround(double(px-vx)*65535/(vw-1)));
        e.mi.dy=LONG(std::llround(double(py-vy)*65535/(vh-1)));
        e.mi.dwFlags=MOUSEEVENTF_MOVE|MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK;
        return send(e);
    }
    bool key(uint32_t scan,bool ext,bool down,bool repeat) {
        if(!allowedScan(scan,ext))return false;
        size_t index=scan+(ext?256:0);
        if(down && ledger_->candidates[index] && !repeat)return false;
        if(!down && !ledger_->candidates[index])return false;
        bool ctrl=(scan==0x1d&&down)||ledger_->candidates[0x1d]||ledger_->candidates[256+0x1d]||(GetAsyncKeyState(VK_CONTROL)&0x8000);
        bool alt=(scan==0x38&&down)||ledger_->candidates[0x38]||ledger_->candidates[256+0x38]||(GetAsyncKeyState(VK_MENU)&0x8000);
        bool shift=((scan==0x2a||scan==0x36)&&down)||ledger_->candidates[0x2a]||ledger_->candidates[0x36]||(GetAsyncKeyState(VK_SHIFT)&0x8000);
        bool f10=(scan==0x44&&down)||ledger_->candidates[0x44]||(GetAsyncKeyState(VK_F10)&0x8000);
        bool del=(scan==0x53&&ext&&down)||ledger_->candidates[256+0x53];
        if(down && ((ctrl&&alt&&shift&&f10)||(ctrl&&alt&&del)))return false;
        INPUT e{};e.type=INPUT_KEYBOARD;e.ki.wScan=WORD(scan);e.ki.dwExtraInfo=InputTag;
        e.ki.dwFlags=KEYEVENTF_SCANCODE|(ext?KEYEVENTF_EXTENDEDKEY:0)|(down?0:KEYEVENTF_KEYUP);
        if(down)InterlockedExchange(&ledger_->candidates[index],1);
        if(!send(e))return false;
        if(!down)InterlockedExchange(&ledger_->candidates[index],0);
        return true;
    }
    void input(const std::vector<uint8_t>& data) {
        if(!active_){reply("{\"event\":\"rejected\",\"reason\":\"inactive\"}");return;}
        if(emergencyStop_){close("emergency_stop");return;}
        if(localStop_){close("local_takeover",true,false,TrustedUi::Mode::Paused);return;}
        rc::Input e{};memcpy(&e,data.data(),sizeof(e));
        if(e.magic!=rc::Magic || e.version!=rc::Version || e.epoch!=arm_.epoch ||
           memcmp(e.session,arm_.session,16)||memcmp(e.share,arm_.share,16)||memcmp(e.generation,arm_.generation,16) ||
           !verify(e)){close("invalid_signature_or_binding");return;}
        uint8_t zero[8]{};if(memcmp(e.reserved,zero,8)){close("invalid_reserved");return;}
        bool fresh=false;for(const auto& c:challenges_)if(c.expires>now()&&!memcmp(c.nonce.data(),e.challenge,16))fresh=true;
        if(!fresh || now()>=deadline_){close("expired_input");return;}
        if(e.kind==rc::Kind::Heartbeat) {
            if(e.seq<=lastHeartbeat_)return;
            lastHeartbeat_=e.seq;controllerBeat_=now();
            reply("{\"event\":\"heartbeatAck\",\"seq\":"+std::to_string(e.seq)+"}");return;
        }
        if(e.seq<=lastSeq_){ack();return;}
        if(e.seq!=lastSeq_+1){close("input_gap");return;}
        if(now()-rateWindow_>=1000){rateWindow_=now();rateCount_=textCount_=0;}
        if(++rateCount_>120){close("rate_limit");return;}
        if(e.textLength>256 || !std::isfinite(e.x)||!std::isfinite(e.y)||e.x<0||e.x>1||e.y<0||e.y>1||e.flags>3){close("invalid_event");return;}
        bool ok=false;
        switch(e.kind) {
        case rc::Kind::Move:ok=move(e.x,e.y);break;
        case rc::Kind::Button: {
            if(e.code>2||e.action>1)break;
            size_t index=ButtonBase+e.code;
            if(bool(ledger_->candidates[index])==bool(e.action))break;
            if(!move(e.x,e.y))break;
            INPUT n{};n.type=INPUT_MOUSE;n.mi.dwExtraInfo=InputTag;
            DWORD down[]={MOUSEEVENTF_LEFTDOWN,MOUSEEVENTF_RIGHTDOWN,MOUSEEVENTF_MIDDLEDOWN};
            DWORD up[]={MOUSEEVENTF_LEFTUP,MOUSEEVENTF_RIGHTUP,MOUSEEVENTF_MIDDLEUP};
            n.mi.dwFlags=e.action?down[e.code]:up[e.code];
            if(e.action)InterlockedExchange(&ledger_->candidates[index],1);
            ok=send(n);if(ok&&!e.action)InterlockedExchange(&ledger_->candidates[index],0);break;
        }
        case rc::Kind::Wheel: {
            if(std::abs(int64_t(e.delta))>1200||!move(e.x,e.y))break;
            INPUT n{};n.type=INPUT_MOUSE;n.mi.dwExtraInfo=InputTag;n.mi.dwFlags=MOUSEEVENTF_WHEEL;n.mi.mouseData=e.delta;ok=send(n);break;
        }
        case rc::Kind::Key:if(e.action<=1)ok=key(e.code,(e.flags&1)!=0,e.action==1,(e.flags&2)!=0);break;
        case rc::Kind::Text: {
            if(++textCount_>4||!emptyLedger(ledger_))break;
            ok=true;
            for(uint32_t i=0;i<e.textLength && ok;++i) {
                INPUT pair[2]{};for(auto& n:pair){n.type=INPUT_KEYBOARD;n.ki.wScan=e.text[i];n.ki.dwFlags=KEYEVENTF_UNICODE;n.ki.dwExtraInfo=InputTag;}
                pair[1].ki.dwFlags|=KEYEVENTF_KEYUP;
                if(!active_ || ledger_->gate!=1 || localStop_ || now()>=deadline_ || !ui_.ready() || ui_.ownsForeground()){ok=false;break;}
                if(!defaultDesktop()){ledger_->cleanup=-2;ok=false;break;}
                InterlockedExchange(&ledger_->unicodeCandidate,LONG(e.text[i])+1);
                ok=SendInput(2,pair,sizeof(INPUT))==2;
                if(!defaultDesktop()){ledger_->cleanup=-2;ok=false;}
                if(ok)InterlockedExchange(&ledger_->unicodeCandidate,0);
            }break;
        }
        case rc::Kind::Release:ok=release(ledger_);break;
        default:break;
        }
        if(!ok){
            if(emergencyStop_)close("emergency_stop");
            else if(localStop_)close("local_takeover",true,false,TrustedUi::Mode::Paused);
            else close("input_failed");
            return;
        }
        lastSeq_=e.seq;ack();
        if(e.kind==rc::Kind::Release)close("input_released");
    }
    void ack(){reply("{\"event\":\"inputAck\",\"seq\":"+std::to_string(lastSeq_)+"}");}
    HANDLE parent_=nullptr,mapping_=nullptr,guard_=nullptr;
    Ledger* ledger_=nullptr;
    BCRYPT_ALG_HANDLE ecdsa_=nullptr;BCRYPT_KEY_HANDLE key_=nullptr;
    std::mutex mutex_;
    std::thread watch_,hookThread_;DWORD hookId_=0;
    std::atomic<bool> running_{true},hooksStarted_{false},hooksReady_{false},activeFlag_{false},localStop_{false},emergencyStop_{false};
    TrustedUi ui_;std::mutex uiEventsMutex_;std::deque<UiEvent> uiEvents_;
    rc::Consent consent_{};bool consentPending_=false,consentApproved_=false,consentUsed_=false;
    Monitor consentMonitor_{};uint64_t displayChecked_=0;
    uint64_t consentExpires_=0;
    bool active_=false;rc::Arm arm_{};
    uint64_t deadline_=0,controllerBeat_=0,lastSeq_=0,lastHeartbeat_=0,rateWindow_=0;
    unsigned rateCount_=0,textCount_=0;
    std::vector<Challenge> challenges_;
};
Runtime* Runtime::instance_=nullptr;
bool readAll(HANDLE pipe,void* buffer,DWORD count) {
    auto* p=static_cast<uint8_t*>(buffer);while(count){DWORD n=0;if(!ReadFile(pipe,p,count,&n,nullptr)||n==0)return false;p+=n;count-=n;}return true;
}
}
int wmain(int argc,wchar_t** argv) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    if(argc==6 && wcscmp(argv[1],L"--guardian")==0)
        return guardian(reinterpret_cast<HANDLE>(_wcstoui64(argv[2],nullptr,10)),reinterpret_cast<HANDLE>(_wcstoui64(argv[3],nullptr,10)),reinterpret_cast<HANDLE>(_wcstoui64(argv[4],nullptr,10)),reinterpret_cast<HANDLE>(_wcstoui64(argv[5],nullptr,10)));
    if(argc!=3 || wcscmp(argv[1],L"--parent")!=0)return 2;
    try {
        Runtime runtime;runtime.start(DWORD(wcstoul(argv[2],nullptr,10)));
        HANDLE input=GetStdHandle(STD_INPUT_HANDLE);
        for(;;){uint32_t header[2]{};if(!readAll(input,header,8))break;if(header[0]>rc::MaxFrame)return 3;
            std::vector<uint8_t> data(header[0]);if(!readAll(input,data.data(),header[0]))break;
            runtime.handle(static_cast<rc::Command>(header[1]),data);
        }
    }catch(const std::exception& e){reply(std::string("{\"event\":\"fatal\",\"reason\":\"")+e.what()+"\"}");return 1;}
    return 0;
}
