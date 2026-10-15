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
}

int wmain() {
    try {
        unsigned cases=0;
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
        std::cout<<"Cleanup fault cases passed: "<<cases<<"; real input calls: 0\n";
        return 0;
    }catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
