// Exercise the production key policy with synthetic held-key state only.
// This executable never starts Runtime, registers hooks or calls SendInput.
#define wmain unused_remote_input_entry
#include "main.cpp"
#undef wmain

namespace {
struct Key {uint32_t scan;bool extended;int virtualKey;};
constexpr Key Ctrl[2]={{0x1d,false,VK_CONTROL},{0x1d,true,VK_CONTROL}};
constexpr Key Alt[2]={{0x38,false,VK_MENU},{0x38,true,VK_MENU}};
constexpr Key Shift[2]={{0x2a,false,VK_SHIFT},{0x36,false,VK_SHIFT}};
constexpr Key F10{0x44,false,VK_F10},Delete{0x53,true,VK_DELETE};
unsigned sequences=0,decisions=0;
void expect(bool value,const char* reason){if(!value)throw std::runtime_error(reason);}
size_t index(Key key){return key.scan+(key.extended?256:0);}

void chord(const std::vector<Key>& keys) {
    const auto limit=1u<<static_cast<unsigned>(keys.size());
    // Every partition with at least one remotely pressed key. The complementary
    // keys are already held locally before the first remote down is evaluated.
    for(unsigned physical=0;physical<limit-1;++physical) {
        std::array<SHORT,256> state{};
        std::vector<size_t> remote;
        for(size_t i=0;i<keys.size();++i) {
            if(physical&(1u<<i))state[keys[i].virtualKey]=static_cast<SHORT>(0x8000);
            else remote.push_back(i);
        }
        do {
            Ledger ledger{};
            for(size_t position=0;position<remote.size();++position) {
                const auto key=keys[remote[position]];
                const bool final=position+1==remote.size();
                expect(allowedScan(key.scan,key.extended),"test chord key rejected by allowlist");
                const bool denied=forbiddenKeyDown(&ledger,key.scan,key.extended,[&](int vk){return state[vk];});
                ++decisions;
                expect(denied==final,final?"completed reserved chord allowed":"incomplete chord rejected");
                if(!denied)ledger.candidates[index(key)]=1;
            }
            ++sequences;
        }while(std::next_permutation(remote.begin(),remote.end()));
    }
}

void legitimateKeys() {
    // Independent or incomplete F10 chords stay usable. Both side variants and
    // already-held repeated down must not become a blanket F10 prohibition.
    for(const auto ctrl:Ctrl)for(const auto alt:Alt)for(const auto shift:Shift) {
        const std::array<Key,3> modifiers{ctrl,alt,shift};
        for(unsigned mask=0;mask<7;++mask) {
            Ledger ledger{};
            for(size_t i=0;i<modifiers.size();++i)if(mask&(1u<<i))ledger.candidates[index(modifiers[i])]=1;
            for(bool repeat:{false,true}) {
                ledger.candidates[index(F10)]=repeat?1:0;
                expect(!forbiddenKeyDown(&ledger,F10.scan,false,[](int){return SHORT(0);}),"legitimate F10 rejected");
                ++decisions;
            }
        }
    }
    Ledger ledger{};ledger.candidates[index(Ctrl[1])]=1;ledger.candidates[index(Alt[1])]=1;
    expect(!forbiddenKeyDown(&ledger,0x53,false,[](int){return SHORT(0);}),"numpad decimal confused with Delete");
    ++decisions;
    // GetAsyncKeyState's low bit reports historical activity, not a held key.
    expect(!forbiddenKeyDown(&ledger,F10.scan,false,[](int){return SHORT(1);}),"historical low bit treated as held");
    ++decisions;
    for(uint32_t scan:{0u,0x54u,0x55u,0x56u,0x59u,0x100u,0xffffffffu}) {
        expect(!allowedScan(scan,false),"unsupported scan allowed");++decisions;
    }
    for(uint32_t scan:{0x2au,0x36u,0x44u,0x5bu,0x5cu,0x5du,0x5eu,0x5fu,0x63u}) {
        expect(!allowedScan(scan,true),"unsupported system/extended scan allowed");++decisions;
    }
}
}

int wmain() {
    try {
        for(const auto ctrl:Ctrl)for(const auto alt:Alt)for(const auto shift:Shift)chord({ctrl,alt,shift,F10});
        for(const auto ctrl:Ctrl)for(const auto alt:Alt)chord({ctrl,alt,Delete});
        legitimateKeys();
        expect(sequences==572,"exhaustive sequence coverage changed");
        std::cout<<"Reserved-chord sequences passed: "<<sequences<<"; policy decisions: "<<decisions<<"; real input calls: 0\n";
        return 0;
    }catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
