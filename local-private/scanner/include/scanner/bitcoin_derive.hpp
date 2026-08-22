#pragma once

#include <string>
#include <vector>

#include "scanner/bip32.hpp"
#include "scanner/types.hpp"

namespace scanner {

struct DerivedAddress {
  std::string address;
  std::vector<uint8_t> hash160;
  std::vector<uint8_t> priv32;
  DerivationPath path;
};

std::vector<DerivationPath> build_derivation_paths(const ScanConfig& cfg);
std::vector<DerivedAddress> derive_addresses(const std::vector<uint8_t>& seed_entropy,
                                             const std::vector<DerivationPath>& paths);

}  // namespace scanner
