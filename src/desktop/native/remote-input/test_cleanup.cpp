// Compile the production release implementation, but invoke it only with
// deterministic callbacks. This executable never starts Runtime or SendInput.
#define wmain unused_remote_input_entry
#include "main.cpp"
#undef wmain

namespace {
std::vector<INPUT> observed;
unsigned checks=0,unsafeAt=0,rejectedAt=0;
bool desktopCheck(){return ++checks!=unsafeAt;}
UINT WINAPI insertTest(UINT count,LPINPUT input,int size) {
    if(count!=1 || size!=int(sizeof(INPUT)))throw std::runtime_error("invalid_insertion_shape");
    observed.push_back(*input);
    return observed.size()==rejectedAt?0:1;
}
void expect(bool value,const char* reason){if(!value)throw std::runtime_error(reason);}
void reset(){observed.clear();checks=unsafeAt=rejectedAt=0;}
Ledger held() {
    Ledger ledger{};ledger.gate=1;ledger.cleanup=0;
    ledger.unicodeCandidate=LONG(0x4e2d)+1;
    ledger.candidates[0x1d]=1;ledger.candidates[256+0x1d]=1;
    ledger.candidates[ButtonBase]=1;ledger.candidates[ButtonBase+1]=1;ledger.candidates[ButtonBase+2]=1;
    return ledger;
}
void retained(Ledger* ledger) {
    expect(ledger->unicodeCandidate==LONG(0x4e2d)+1,"unicode candidate discarded");
    for(size_t i:{size_t(0x1d),size_t(256+0x1d),ButtonBase,ButtonBase+1,ButtonBase+2})
        expect(ledger->candidates[i]==1,"candidate discarded");
    expect(ledger->gate==0,"gate reopened");
}
template<class Checkpoint>
bool cleanupOperation(Ledger* ledger,unsigned operation,Checkpoint checkpoint) {
    if(operation==0)return release(ledger,[](){return true;},insertTest,checkpoint);
    if(operation==1)return completeUp(ledger,0x1d,0,desktopGeneration(ledger),checkpoint);
    if(operation==2)return completeUp(ledger,ButtonBase,0,desktopGeneration(ledger),checkpoint);
    if(operation==3)return completeUp(ledger,CandidateCount,LONG(0x4e2d)+1,desktopGeneration(ledger),checkpoint);
    throw std::runtime_error("invalid test operation");
}
int crashChild(int argc,wchar_t** argv) {
    if(argc!=6)return 70;
    HANDLE mapping=reinterpret_cast<HANDLE>(_wcstoui64(argv[2],nullptr,10));
    auto* ledger=static_cast<Ledger*>(MapViewOfFile(mapping,FILE_MAP_ALL_ACCESS,0,0,sizeof(Ledger)));
    if(!ledger)return 71;
    const unsigned target=wcstoul(argv[3],nullptr,10);
    const bool transition=wcstoul(argv[4],nullptr,10)!=0;
    const unsigned operation=wcstoul(argv[5],nullptr,10);
    unsigned step=0;
    cleanupOperation(ledger,operation,[&](ReleaseStep){
        if(++step!=target)return;
        if(transition)invalidateDesktop(ledger);
        // Deliberately bypass C++ destructors and any in-process restoration.
        if(!TerminateProcess(GetCurrentProcess(),73))ExitProcess(74);
    });
    UnmapViewOfFile(ledger);CloseHandle(mapping);return 72;
}
void crashCase(unsigned target,bool transition,bool committed,unsigned operation) {
    SECURITY_ATTRIBUTES security{sizeof(security),nullptr,TRUE};
    HANDLE mapping=CreateFileMappingW(INVALID_HANDLE_VALUE,&security,PAGE_READWRITE,0,sizeof(Ledger),nullptr);
    expect(mapping!=nullptr,"test mapping failed");
    auto* ledger=static_cast<Ledger*>(MapViewOfFile(mapping,FILE_MAP_ALL_ACCESS,0,0,sizeof(Ledger)));
    if(!ledger){CloseHandle(mapping);throw std::runtime_error("test map view failed");}
    *ledger=held();
    try {
        wchar_t path[32768]{};expect(GetModuleFileNameW(nullptr,path,32768)!=0,"test executable path failed");
        std::wstring command=L"\""+std::wstring(path)+L"\" --crash-release "+
            std::to_wstring(reinterpret_cast<uintptr_t>(mapping))+L" "+std::to_wstring(target)+L" "+(transition?L"1":L"0")+L" "+std::to_wstring(operation);
        SIZE_T size=0;InitializeProcThreadAttributeList(nullptr,1,0,&size);
        std::vector<uint8_t> storage(size);STARTUPINFOEXW startup{};startup.StartupInfo.cb=sizeof(startup);
        startup.lpAttributeList=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
        expect(InitializeProcThreadAttributeList(startup.lpAttributeList,1,0,&size)!=0,"test attributes failed");
        PROCESS_INFORMATION process{};
        const bool inherited=UpdateProcThreadAttribute(startup.lpAttributeList,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,&mapping,sizeof(mapping),nullptr,nullptr)!=0;
        const bool created=inherited && CreateProcessW(path,command.data(),nullptr,nullptr,TRUE,CREATE_NO_WINDOW|EXTENDED_STARTUPINFO_PRESENT,nullptr,nullptr,&startup.StartupInfo,&process);
        DeleteProcThreadAttributeList(startup.lpAttributeList);expect(created,"test child spawn failed");
        CloseHandle(process.hThread);
        const DWORD waited=WaitForSingleObject(process.hProcess,3000);
        if(waited!=WAIT_OBJECT_0){TerminateProcess(process.hProcess,74);WaitForSingleObject(process.hProcess,1000);}
        DWORD code=0;GetExitCodeProcess(process.hProcess,&code);CloseHandle(process.hProcess);
        expect(waited==WAIT_OBJECT_0 && code==73,"test child did not stop at checkpoint");
        // Recovery uses only the mapping left by the now-confirmed dead child.
        InterlockedExchange(&ledger->gate,0);
        recoverReleaseJournal(ledger);
        if(!committed)retained(ledger);
        reset();
        const bool released=release(ledger,desktopCheck,insertTest);
        if(transition) {
            expect(!released && ledger->cleanup==-2 && observed.empty(),"transition crash resumed input");
        } else {
            expect(released && emptyLedger(ledger) && ledger->cleanup==1,"crash recovery did not clean candidates");
            expect(observed.size()==(committed?(operation?5:0):6),"recovery lost or invented candidates");
        }
    }catch(...){UnmapViewOfFile(ledger);CloseHandle(mapping);throw;}
    UnmapViewOfFile(ledger);CloseHandle(mapping);
}
}

int wmain(int argc,wchar_t** argv) {
    if(argc>1 && wcscmp(argv[1],L"--crash-release")==0)return crashChild(argc,argv);
    try {
        unsigned cases=0;
        for(LONG prior:{LONG(0),LONG(1),LONG(-1),LONG(-2)}) {
            Ledger ledger{};ledger.cleanup=prior;failCleanup(&ledger);
            expect(ledger.cleanup==(prior<0?prior:-1),"failed termination did not preserve negative cleanup");++cases;
        }
        // Empty ledgers are safe without any OS input or desktop query, while
        // a prior failed/uncertain result remains sticky even after unlock.
        for(LONG prior:{LONG(0),LONG(-1),LONG(-2)}) {
            reset();Ledger ledger{};ledger.gate=1;ledger.cleanup=prior;unsafeAt=1;
            const bool result=release(&ledger,desktopCheck,insertTest);
            expect(result==(prior==0),"empty cleanup result");
            expect(ledger.cleanup==(prior==0?1:prior),"negative cleanup reset");
            expect(observed.empty() && checks==0 && ledger.gate==0,"empty cleanup called OS adapter");
            ++cases;
        }
        reset();auto success=held();
        expect(release(&success,desktopCheck,insertTest),"normal cleanup failed");
        expect(emptyLedger(&success) && success.cleanup==1 && success.gate==0,"normal cleanup did not commit");
        expect(observed.size()==6,"released an unrelated key or omitted a candidate");
        expect(observed[0].ki.wScan==0x4e2d && observed[0].ki.dwFlags==(KEYEVENTF_UNICODE|KEYEVENTF_KEYUP),"unicode up shape");
        expect(observed[1].ki.wScan==0x1d && observed[1].ki.dwFlags==(KEYEVENTF_SCANCODE|KEYEVENTF_KEYUP),"key up shape");
        expect(observed[2].ki.dwFlags==(KEYEVENTF_SCANCODE|KEYEVENTF_KEYUP|KEYEVENTF_EXTENDEDKEY),"extended key up shape");
        const DWORD buttons[]={MOUSEEVENTF_LEFTUP,MOUSEEVENTF_RIGHTUP,MOUSEEVENTF_MIDDLEUP};
        for(size_t i=0;i<observed.size();++i) {
            if(i<3)expect(observed[i].type==INPUT_KEYBOARD && observed[i].ki.dwExtraInfo==InputTag,"key tag/type");
            else expect(observed[i].type==INPUT_MOUSE && observed[i].mi.dwFlags==buttons[i-3] && observed[i].mi.dwExtraInfo==InputTag,"button tag/type");
        }
        const unsigned checkpoints=checks;++cases;
        // Simulate a one-check desktop loss, including after a successful up
        // and between consecutive candidates. Returning later cannot erase it.
        for(unsigned point=1;point<=checkpoints;++point) {
            reset();auto ledger=held();unsafeAt=point;
            expect(!release(&ledger,desktopCheck,insertTest),"unsafe desktop reported clean");
            expect(ledger.cleanup==-2 && checks==point,"uncertainty did not stop immediately");
            retained(&ledger);
            const auto emitted=observed.size();unsafeAt=0;
            expect(!release(&ledger,desktopCheck,insertTest),"uncertainty automatically recovered");
            expect(observed.size()==emitted && checks==point,"sticky uncertainty retried input");
            ++cases;
        }
        // Both desktop samples still report Default, but a delivered transition
        // increments the shared generation. Never erase that intervening event.
        for(unsigned point=1;point<=checkpoints;++point) {
            reset();auto ledger=held();
            auto transition=[&](){if(++checks==point)invalidateDesktop(&ledger);return true;};
            expect(!release(&ledger,transition,insertTest),"desktop round trip reported clean");
            expect(ledger.cleanup==-2 && ledger.desktopInvalid==1 && desktopGeneration(&ledger)==1,"transition latch lost");
            retained(&ledger);++cases;
        }
        reset();auto earlier=held();invalidateDesktop(&earlier);
        expect(!release(&earlier,desktopCheck,insertTest) && observed.empty(),"earlier transition allowed cleanup");
        retained(&earlier);++cases;
        // Observation liveness is separate from the worker's command heartbeat.
        Ledger health{};health.workerObserverReady=health.guardianObserverReady=1;
        health.workerObserverBeat=health.guardianObserverBeat=now();
        expect(observersHealthy(&health),"fresh observers unavailable");
        health.workerObserverBeat=static_cast<LONG64>(now()-rc::WatchdogMs-1);
        expect(!observersHealthy(&health) && observersHealthy(&health,false),"stalled worker observer accepted");
        expect(cleanupObserverHealthy(&health),"surviving guardian cannot supervise cleanup");
        health.guardianObserverBeat=static_cast<LONG64>(now()-rc::WatchdogMs-1);
        expect(!observersHealthy(&health,false) && !cleanupObserverHealthy(&health),"two stalled observers accepted");
        health.workerObserverBeat=now();
        expect(!observersHealthy(&health) && cleanupObserverHealthy(&health),"surviving worker cannot supervise cleanup");++cases;
        for(unsigned rejected=1;rejected<=6;++rejected) {
            reset();auto ledger=held();rejectedAt=rejected;
            expect(!release(&ledger,desktopCheck,insertTest) && ledger.cleanup==-1,"API rejection reported clean");
            retained(&ledger);
            expect(observed.size()==6,"safe desktop did not attempt other candidate ups");
            const auto emitted=observed.size();rejectedAt=0;
            expect(!release(&ledger,desktopCheck,insertTest) && observed.size()==emitted,"failed cleanup automatically retried");
            ++cases;
        }
        reset();auto both=held();rejectedAt=1;unsafeAt=3;
        expect(!release(&both,desktopCheck,insertTest) && both.cleanup==-2,"desktop uncertainty lost to API failure");
        retained(&both);++cases;
        unsigned processes=0;
        for(unsigned operation=0;operation<4;++operation) {
            reset();auto example=held();std::vector<ReleaseStep> steps;
            expect(cleanupOperation(&example,operation,[&](ReleaseStep step){steps.push_back(step);}),"checkpoint baseline failed");
            for(unsigned index=0;index<steps.size();++index) {
                const bool committed=steps[index]==ReleaseStep::Committed;
                try {
                    crashCase(index+1,false,committed,operation);++processes;
                    // A transition after the atomic commit belongs to the next desktop
                    // state; earlier windows must preserve all affected candidates.
                    if(!committed){crashCase(index+1,true,false,operation);++processes;}
                }catch(...){std::cerr<<"Crash operation="<<operation<<" checkpoint="<<index+1<<'\n';throw;}
            }
        }
        std::cout<<"Cleanup fault cases passed: "<<cases<<"; real input calls: 0\n";
        std::cout<<"Confirmed child-process crash cases passed: "<<processes<<"; real input calls: 0\n";
        return 0;
    }catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
