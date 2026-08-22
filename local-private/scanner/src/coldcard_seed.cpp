#include "scanner/coldcard_seed.hpp"

#include "scanner/crypto_aes.hpp"

#include <algorithm>
#include <cstring>

namespace scanner {

void my_random_bytes(YasmarangRng& mp, LibnguYasmarang& lib, uint8_t* dest, uint32_t count) {
  uint32_t last = 0;
  uint32_t offset = 0;
  while (offset < count) {
    uint32_t chip = mp.rng_get();
    if (chip == last) {
      // Firmware raises OSError; we skip identical consecutive words.
      continue;
    }
    last = chip;
    chip ^= lib.rng_get();

    const uint32_t here = std::min(4u, count - offset);
    memcpy(dest + offset, &chip, here);
    offset += here;
  }
}

std::vector<uint8_t> coldcard_seed_entropy(uint32_t pad, uint32_t prior_draws) {
  YasmarangRng mp;
  LibnguYasmarang lib;
  mp.reset_cold_start(pad);
  for (uint32_t i = 0; i < prior_draws; i++) {
    mp.rng_get();
    lib.rng_get();
  }
  std::vector<uint8_t> raw(32);
  my_random_bytes(mp, lib, raw.data(), 32);
  return sha256d(raw);
}

}  // namespace scanner
