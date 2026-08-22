#pragma once

#include <cstdint>
#include <vector>

#include "scanner/types.hpp"
#include "scanner/yasmarang.hpp"

namespace scanner {

void my_random_bytes(YasmarangRng& mp, LibnguYasmarang& lib, uint8_t* dest, uint32_t count);

// CPU reference: Mk3 firmware generate_seed path (ngu.random.bytes + sha256d).
std::vector<uint8_t> coldcard_seed_entropy(uint32_t pad, uint32_t prior_draws);

}  // namespace scanner
