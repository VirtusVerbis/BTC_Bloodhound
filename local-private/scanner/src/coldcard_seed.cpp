#include "scanner/coldcard_seed.hpp"

#include "scanner/yasmarang.hpp"

namespace scanner {

std::vector<uint8_t> random_bytes(YasmarangRng& rng, size_t count) {
  std::vector<uint8_t> out(count);
  for (size_t i = 0; i < count; i++) {
    out[i] = static_cast<uint8_t>(rng.rng_get() & 0xff);
  }
  return out;
}

std::vector<uint8_t> coldcard_seed_entropy(uint32_t pad, uint32_t scan_session_count) {
  YasmarangRng rng;
  rng.reset_cold_start(pad);
  for (uint32_t i = 0; i < scan_session_count; i++) {
    rng.rng_get();
  }
  return random_bytes(rng, 32);
}

}  // namespace scanner
