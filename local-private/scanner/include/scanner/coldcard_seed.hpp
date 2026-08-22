#pragma once

#include <cstdint>
#include <vector>

#include "scanner/types.hpp"

namespace scanner {

class YasmarangRng;

std::vector<uint8_t> random_bytes(YasmarangRng& rng, size_t count);
std::vector<uint8_t> coldcard_seed_entropy(uint32_t pad, uint32_t scan_session_count);

}  // namespace scanner
