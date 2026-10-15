#pragma once
#include <cstdint>
#include <cstddef>

namespace rc {
// All wire integers are little endian. No pointers or native handles cross this
// interface. The parent is the trusted Electron main process, never a renderer.
constexpr uint32_t Version = 1;
constexpr uint32_t Magic = 0x31435257; // WRC1
constexpr uint32_t MaxFrame = 4096;
constexpr uint64_t ChallengeMs = 3000;
constexpr uint64_t WatchdogMs = 2500;
enum class Command : uint32_t { Hello=1, Arm=2, Challenge=3, ParentAlive=4, Close=5, Lease=6, Input=7 };
enum class Kind : uint16_t { Move=1, Button=2, Wheel=3, Key=4, Text=5, Release=6, Heartbeat=7 };
#pragma pack(push, 1)
struct Arm {
    uint8_t session[16], share[16], generation[16];
    uint32_t epoch;
    int32_t left, top, width, height;
    uint32_t leaseMs;
    uint8_t publicKey[64]; // P-256 uncompressed X || Y, unsigned big endian
};
struct Input {
    uint32_t magic, version;
    uint8_t session[16], share[16], generation[16];
    uint32_t epoch;
    Kind kind;
    uint16_t action; // 0=up, 1=down (key/button only)
    uint64_t seq;
    uint8_t challenge[16];
    uint32_t code, flags; // flags=1 extended scan code, 2 key repeat
    double x, y;
    int32_t delta;
    uint32_t textLength;
    uint16_t text[256];
    uint8_t reserved[8];
    uint8_t signature[64]; // IEEE P1363, SHA-256 over bytes [0,640)
};
#pragma pack(pop)
static_assert(sizeof(Arm) == 136);
static_assert(offsetof(Input, signature) == 640);
static_assert(sizeof(Input) == 704);
}
