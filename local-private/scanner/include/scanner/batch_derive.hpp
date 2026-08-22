#pragma once

#include <cstdint>
#include <vector>

#include "cuda/gpu_api.h"
#include "scanner/gpu_types.hpp"
#include "scanner/types.hpp"

namespace scanner {

struct PathLayout {
  std::vector<CudaPrefixDesc> prefixes;
  std::vector<CudaLeafDesc> leaves;
};

// Flat privkeys: seeds.size() * paths.size() * 32 bytes
std::vector<uint8_t> derive_privkeys_batch(const std::vector<SeedCandidate>& seeds,
                                           const std::vector<DerivationPath>& paths);

std::vector<uint8_t> derive_privkeys_for_seed(const std::vector<uint8_t>& entropy,
                                              const std::vector<DerivationPath>& paths);

// BIP39 + BIP32 master only: seeds.size() * 64 bytes (priv32 + chain32 per seed)
std::vector<uint8_t> masters_for_seeds(const std::vector<SeedCandidate>& seeds);

std::vector<CudaPathDesc> build_cuda_path_descs(const std::vector<DerivationPath>& paths);

PathLayout build_path_layout(const std::vector<DerivationPath>& paths);

std::vector<uint8_t> derive_privkey_for_path(const std::vector<uint8_t>& entropy, const DerivationPath& path);

ScriptFamily script_family_from_path(const DerivationPath& path);

}  // namespace scanner
