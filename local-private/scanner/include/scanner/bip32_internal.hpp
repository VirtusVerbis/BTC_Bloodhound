#pragma once

#include <cstdint>
#include <vector>

#include "scanner/bip32.hpp"
#include "scanner/types.hpp"

namespace scanner {
namespace bip32_internal {

Bip32Key derive_path(const Bip32Key& master, const std::vector<uint32_t>& path_idx, const std::vector<bool>& hardened);
std::vector<uint8_t> privkey_to_pubkey33(const std::vector<uint8_t>& priv32);
void batch_privkey_to_pubkey33(const uint8_t* privkeys, uint8_t* pubkeys33, int count);

}  // namespace bip32_internal
}  // namespace scanner
