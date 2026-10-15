#pragma once
#include <functional>
#include <deque>
#include "protocol.h"

// Owned by the hook/message-loop thread. No HTML, renderer, URL or generic IPC.
// Public operations only enqueue changes; they never synchronously wait for UI
// while holding Runtime's input mutex. Decisions go back with their proposal ID.
class TrustedUi {
public:
    enum class Mode { Hidden, Confirm, Waiting, Active, Paused };
    enum class Event { Shown, Allowed, Denied, Expired, Stop, Resume, Unavailable };
    static constexpr UINT Update = WM_APP+41, Tray = WM_APP+42;
    using Callback = std::function<void(Event,const rc::Consent&)>;

    bool initialize(Callback callback) {
        callback_=std::move(callback);thread_=GetCurrentThreadId();
        WNDCLASSW wc{};wc.lpfnWndProc=procedure;wc.hInstance=GetModuleHandleW(nullptr);
        wc.lpszClassName=L"WeMeetRemoteControlTrustedUi";wc.hCursor=LoadCursorW(nullptr,IDC_ARROW);
        wc.hbrBackground=reinterpret_cast<HBRUSH>(COLOR_WINDOW+1);
        if(!RegisterClassW(&wc) && GetLastError()!=ERROR_CLASS_ALREADY_EXISTS)return false;
        hwnd_=CreateWindowExW(WS_EX_TOPMOST|WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE,wc.lpszClassName,
            L"We-Meet 远程控制",WS_POPUP|WS_BORDER,0,0,1,1,nullptr,nullptr,wc.hInstance,this);
        if(!hwnd_)return false;
        text_=CreateWindowExW(0,L"STATIC",L"",WS_CHILD|WS_VISIBLE|SS_LEFT|SS_NOPREFIX,0,0,1,1,
            hwnd_,nullptr,wc.hInstance,nullptr);
        hint_=CreateWindowExW(0,L"STATIC",L"紧急停止：Ctrl+Alt+Shift+F10",WS_CHILD|SS_LEFT|SS_NOPREFIX,0,0,1,1,
            hwnd_,nullptr,wc.hInstance,nullptr);
        primary_=CreateWindowExW(0,L"BUTTON",L"",WS_CHILD|WS_VISIBLE|BS_PUSHBUTTON,0,0,1,1,
            hwnd_,reinterpret_cast<HMENU>(1),wc.hInstance,nullptr);
        secondary_=CreateWindowExW(0,L"BUTTON",L"",WS_CHILD|WS_VISIBLE|BS_PUSHBUTTON,0,0,1,1,
            hwnd_,reinterpret_cast<HMENU>(2),wc.hInstance,nullptr);
        if(!text_ || !hint_ || !primary_ || !secondary_ || !SetTimer(hwnd_,1,100,nullptr))return false;
        beat_=GetTickCount64();return true;
    }
    void dispose() {
        mode_=Mode::Hidden;removeTray();
        if(hwnd_)DestroyWindow(hwnd_);
        hwnd_=nullptr;if(font_)DeleteObject(font_);font_=nullptr;
    }
    bool present(const rc::Consent& proposal) { return enqueue({Mode::Confirm,proposal,true}); }
    bool setMode(Mode mode) { return enqueue({mode,{},false}); }
    void drain() {
        std::deque<Work> items;
        {std::lock_guard<std::mutex> lock(queueMutex_);items.swap(queue_);}
        for(const auto& item:items) {
            auto previous=mode_.load();
            if(!item.newProposal && (previous==Mode::Waiting || previous==Mode::Active) &&
                (item.mode==Mode::Waiting || item.mode==Mode::Active)) {
                mode_=item.mode;updateText();continue;
            }
            mode_=Mode::Hidden; // close the UI readiness gate before any mutation
            if(item.newProposal) {previousForeground_=GetForegroundWindow();proposal_=item.proposal;expires_=GetTickCount64()+proposal_.timeoutMs;}
            if(!render(item.mode)) {render(Mode::Hidden);callback_(Event::Unavailable,proposal_);}
            else if(item.newProposal)callback_(Event::Shown,proposal_);
        }
    }
    bool ready() const {
        const auto mode=mode_.load();
        HWND window=hwnd_;
        if((mode!=Mode::Waiting && mode!=Mode::Active) || !window || !trayReady_ ||
            GetTickCount64()-beat_.load()>1000 || !IsWindowVisible(window) || IsIconic(window) ||
            !(GetWindowLongPtrW(window,GWL_EXSTYLE)&WS_EX_TOPMOST))return false;
        RECT rect{};if(!GetWindowRect(window,&rect))return false;
        if(rect.left!=left_ || rect.top!=top_ || rect.right!=right_ || rect.bottom!=bottom_)return false;
        // The stop button must remain exposed, not merely have WS_EX_TOPMOST.
        RECT stop{};if(!GetWindowRect(primary_,&stop))return false;
        POINT center{(stop.left+stop.right)/2,(stop.top+stop.bottom)/2};
        HWND hit=WindowFromPoint(center);
        return hit && GetAncestor(hit,GA_ROOT)==window;
    }
    bool allowsPointer(int x,int y) const {
        if(!ready())return false;
        RECT rect{};if(!GetWindowRect(hwnd_,&rect))return false;
        InflateRect(&rect,8,8);POINT point{x,y};return !PtInRect(&rect,point);
    }
    bool ownsForeground() const {
        DWORD pid=0;GetWindowThreadProcessId(GetForegroundWindow(),&pid);
        return pid==GetCurrentProcessId();
    }
private:
    struct Work {Mode mode;rc::Consent proposal;bool newProposal;};
    bool enqueue(Work item) {
        {std::lock_guard<std::mutex> lock(queueMutex_);
            if(queue_.size()>=16)return false;queue_.push_back(item);}
        return PostThreadMessageW(thread_,Update,0,0)!=0;
    }
    bool addTray() {
        if(trayReady_)return true;
        NOTIFYICONDATAW data{};data.cbSize=sizeof(data);data.hWnd=hwnd_;data.uID=1;
        data.uFlags=NIF_MESSAGE|NIF_ICON|NIF_TIP;data.uCallbackMessage=Tray;
        data.hIcon=LoadIconW(nullptr,IDI_APPLICATION);
        wcscpy_s(data.szTip,L"We-Meet 远程控制：右键停止");
        trayReady_=Shell_NotifyIconW(NIM_ADD,&data)!=FALSE;return trayReady_;
    }
    void removeTray() {
        if(trayReady_) {NOTIFYICONDATAW data{};data.cbSize=sizeof(data);data.hWnd=hwnd_;data.uID=1;
            Shell_NotifyIconW(NIM_DELETE,&data);trayReady_=false;}
    }
    bool render(Mode next) {
        if(next==Mode::Hidden) {mode_=next;ShowWindow(hwnd_,SW_HIDE);removeTray();return true;}
        if(!addTray())return false;
        const auto& b=proposal_.binding;
        // GetDpiForWindow follows the selected monitor after placement. Size in
        // physical pixels; a tiny display cannot host a usable control surface.
        SetWindowPos(hwnd_,HWND_TOPMOST,b.left,b.top,1,1,SWP_NOACTIVATE);
        UINT dpi=GetDpiForWindow(hwnd_);if(!dpi)return false;
        const auto px=[dpi](int value){return MulDiv(value,int(dpi),96);};
        const bool confirm=next==Mode::Confirm;
        int width=std::min(b.width-16,px(confirm?620:760));
        int height=px(confirm?300:60);
        if(width<px(480) || b.height<height+16)return false;
        int x=b.left+(b.width-width)/2,y=b.top+8;
        SetWindowLongPtrW(hwnd_,GWL_EXSTYLE,WS_EX_TOPMOST|WS_EX_TOOLWINDOW|(confirm?0:WS_EX_NOACTIVATE));
        SetWindowPos(hwnd_,HWND_TOPMOST,x,y,width,height,SWP_NOACTIVATE|SWP_SHOWWINDOW);
        if(font_)DeleteObject(font_);
        font_=CreateFontW(-px(15),0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,
            OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,CLEARTYPE_QUALITY,DEFAULT_PITCH,L"Segoe UI");
        for(HWND child:{text_,hint_,primary_,secondary_})SendMessageW(child,WM_SETFONT,reinterpret_cast<WPARAM>(font_),TRUE);
        SetWindowLongPtrW(text_,GWL_STYLE,WS_CHILD|WS_VISIBLE|SS_LEFT|SS_NOPREFIX|(confirm?0:SS_ENDELLIPSIS));
        if(confirm) {
            ShowWindow(hint_,SW_HIDE);
            MoveWindow(text_,px(16),px(14),width-px(32),height-px(78),TRUE);
            MoveWindow(primary_,width-px(286),height-px(54),px(126),px(36),TRUE);
            MoveWindow(secondary_,width-px(146),height-px(54),px(126),px(36),TRUE);
            SetWindowTextW(primary_,L"拒绝");SetWindowTextW(secondary_,L"允许本次控制");
            ShowWindow(secondary_,SW_SHOW);EnableWindow(secondary_,TRUE);
        } else {
            MoveWindow(text_,px(12),px(5),width-px(next==Mode::Paused?270:150),px(23),TRUE);
            MoveWindow(hint_,px(12),px(30),width-px(next==Mode::Paused?270:150),px(23),TRUE);
            ShowWindow(hint_,SW_SHOW);
            MoveWindow(primary_,width-px(132),px(12),px(120),height-px(24),TRUE);
            MoveWindow(secondary_,width-px(260),px(12),px(120),height-px(24),TRUE);
            SetWindowTextW(primary_,L"停止控制");SetWindowTextW(secondary_,L"恢复控制…");
            ShowWindow(secondary_,next==Mode::Paused?SW_SHOW:SW_HIDE);
        }
        RECT rect{};if(!GetWindowRect(hwnd_,&rect))return false;
        left_=rect.left;top_=rect.top;right_=rect.right;bottom_=rect.bottom;
        mode_=next;beat_=GetTickCount64();updateText();
        return true;
    }
    void updateText() {
        std::wstring name(reinterpret_cast<const wchar_t*>(proposal_.controller));
        auto mode=mode_.load();std::wstring text;
        if(mode==Mode::Confirm) {
            auto remaining=expires_>GetTickCount64()?(expires_-GetTickCount64()+999)/1000:0;
            text=L"允许 “"+name+L"” 操作这块完整显示器？\r\n"+
                L"显示器："+std::to_wstring(proposal_.binding.width)+L" × "+std::to_wstring(proposal_.binding.height)+L"（完整屏幕）\r\n"+
                L"对方将能使用键盘和鼠标。焦点及快捷键可能影响其他屏幕上的应用，共享画面可能被会议录制。\r\n"+
                L"你可随时停止或按 Ctrl+Alt+Shift+F10；本地操作会暂停控制。\r\n"+
                L"申请剩余 "+std::to_wstring(remaining)+L" 秒，默认拒绝。";
        } else {
            text=(mode==Mode::Active?L"正在被 ":mode==Mode::Paused?L"已暂停 · ":L"等待连接 · ")+name;
        }
        SetWindowTextW(text_,text.c_str());
    }
    void decision(Event event) {
        if(event==Event::Allowed) {
            if(mode_!=Mode::Confirm)return;
            if(GetTickCount64()>=expires_)event=Event::Expired;
        }
        if(event==Event::Allowed) {
            mode_=Mode::Hidden;
            if(!render(Mode::Waiting))event=Event::Unavailable;
            if(previousForeground_ && IsWindow(previousForeground_))SetForegroundWindow(previousForeground_);
        } else if(event==Event::Resume) {
            if(mode_!=Mode::Paused)return;
            if(!render(Mode::Waiting))event=Event::Unavailable;
        } else render(Mode::Hidden);
        callback_(event,proposal_);
    }
    static LRESULT CALLBACK procedure(HWND window,UINT message,WPARAM w,LPARAM l) {
        auto* self=reinterpret_cast<TrustedUi*>(GetWindowLongPtrW(window,GWLP_USERDATA));
        if(message==WM_NCCREATE) {
            self=static_cast<TrustedUi*>(reinterpret_cast<CREATESTRUCTW*>(l)->lpCreateParams);
            SetWindowLongPtrW(window,GWLP_USERDATA,reinterpret_cast<LONG_PTR>(self));
        }
        if(!self)return DefWindowProcW(window,message,w,l);
        switch(message) {
        case WM_TIMER:
            self->beat_=GetTickCount64();
            if(self->mode_==Mode::Confirm) {
                if(GetTickCount64()>=self->expires_)self->decision(Event::Expired);
                else self->updateText();
            }return 0;
        case WM_COMMAND:
            if(HIWORD(w)!=BN_CLICKED)return 0;
            if(LOWORD(w)==1)self->decision(self->mode_==Mode::Confirm?Event::Denied:Event::Stop);
            else if(LOWORD(w)==2)self->decision(self->mode_==Mode::Confirm?Event::Allowed:Event::Resume);
            return 0;
        case WM_CLOSE:self->decision(self->mode_==Mode::Confirm?Event::Denied:Event::Stop);return 0;
        case WM_DISPLAYCHANGE:
        case WM_DPICHANGED:
            // Geometry/DPI changes invalidate the permission, never silently remap.
            if(self->mode_!=Mode::Hidden)self->decision(Event::Unavailable);return 0;
        case Tray:
            if(l==WM_RBUTTONUP || l==WM_LBUTTONUP) {
                HMENU menu=CreatePopupMenu();AppendMenuW(menu,MF_STRING,1,L"停止远程控制");
                POINT p{};GetCursorPos(&p);SetForegroundWindow(window);
                auto selected=TrackPopupMenu(menu,TPM_RETURNCMD|TPM_NONOTIFY,p.x,p.y,0,window,nullptr);
                DestroyMenu(menu);if(selected==1)self->decision(Event::Stop);
            }return 0;
        default:break;
        }
        return DefWindowProcW(window,message,w,l);
    }
    HWND hwnd_=nullptr,text_=nullptr,hint_=nullptr,primary_=nullptr,secondary_=nullptr,previousForeground_=nullptr;
    HFONT font_=nullptr;DWORD thread_=0;
    std::atomic<Mode> mode_{Mode::Hidden};std::atomic<bool> trayReady_{false};
    std::atomic<uint64_t> beat_{0};std::atomic<LONG> left_{0},top_{0},right_{0},bottom_{0};
    uint64_t expires_=0;rc::Consent proposal_{};Callback callback_;
    std::mutex queueMutex_;std::deque<Work> queue_;
};
