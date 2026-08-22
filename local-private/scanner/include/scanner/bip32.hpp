#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace scanner {

struct Bip32Key {
  std::vector<uint8_t> priv32;
  std::vector<uint8_t> chain32;
};

Bip32Key bip32_master(const std::vector<uint8_t>& seed);
Bip32Key bip32_child(const Bip32Key& parent, uint32_t child_index, bool hardened);
std::vector<uint8_t> hash160(const std::vector<uint8_t>& data);

}  // namespace scanner
