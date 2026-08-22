#pragma once

#include <cstdint>

namespace scanner {

struct YasmarangState {
  uint32_t pad = 0;
  uint32_t n = 0;
  uint32_t d = 0;
  uint8_t dat = 0;
};

uint32_t yasmarang_step(YasmarangState& st);

class YasmarangRng {
 public:
  YasmarangRng();

  // Cold-start Mk3: pad = UID[0] ^ SysTick; RTC TR/SSR zero.
  void reset_cold_start(uint32_t pad);

  uint32_t rng_get();

  uint32_t pad() const { return st_.pad; }
  uint32_t n() const { return st_.n; }
  uint32_t d() const { return st_.d; }
  uint8_t dat() const { return st_.dat; }

 private:
  bool seeded_ = false;
  YasmarangState st_{};
};

// libngu my_yasmarang() — fixed Mk3 init, identical on every device.
class LibnguYasmarang {
 public:
  LibnguYasmarang();

  uint32_t rng_get();

 private:
  YasmarangState st_{};
};

}  // namespace scanner
