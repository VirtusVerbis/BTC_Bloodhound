#pragma once

#include <string>
#include <vector>

#include "scanner/types.hpp"

namespace scanner {

std::vector<uint8_t> bip39_seed_from_entropy(const std::vector<uint8_t>& entropy);
std::string entropy_to_mnemonic(const std::vector<uint8_t>& entropy);

}  // namespace scanner
