#pragma once

#include <cstdint>
#include <vector>

namespace scanner {

enum class ScriptFamily : uint8_t { Bip84 = 0, Bip49 = 1, Bip44 = 2 };

struct SeedCandidate {
  uint32_t pad = 0;
  uint32_t scan_session = 0;
  std::vector<uint8_t> entropy;  // 32 bytes
};

struct GpuHit {
  uint32_t seed_index = 0;
  uint32_t path_index = 0;
  uint32_t victim_index = 0;
  uint8_t hash20[20]{};
};

struct VictimLookupKey {
  std::vector<uint8_t> key20;  // 20 bytes
  uint32_t victim_index = 0;
  ScriptFamily family = ScriptFamily::Bip84;
};

}  // namespace scanner
