#pragma once

#include <string>
#include <vector>

#include "scanner/gpu_types.hpp"
#include "scanner/types.hpp"

namespace scanner {

std::string encode_address(ScriptFamily family, const uint8_t* pubkey33, const uint8_t* pubkey_hash20);

std::string encode_address_for_path(const DerivationPath& path, const uint8_t* pubkey33,
                                    const uint8_t* pubkey_hash20);

}  // namespace scanner
