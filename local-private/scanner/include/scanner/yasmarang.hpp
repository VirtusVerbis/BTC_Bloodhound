#pragma once

#include <cstdint>

namespace scanner {

class YasmarangRng {
 public:
  YasmarangRng();

  // Cold-start Mk3: pad = UID[0] ^ SysTick; RTC TR/SSR zero.
  void reset_cold_start(uint32_t pad);

  uint32_t rng_get();

  uint32_t pad() const { return pad_; }
  uint32_t n() const { return n_; }
  uint32_t d() const { return d_; }
  uint8_t dat() const { return dat_; }

 private:
  bool seeded_;
  uint32_t pad_;
  uint32_t n_;
  uint32_t d_;
  uint8_t dat_;
};

}  // namespace scanner
