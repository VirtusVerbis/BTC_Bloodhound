#include "scanner/yasmarang.hpp"

namespace scanner {

uint32_t yasmarang_step(YasmarangState& st) {
  st.pad += st.dat + st.d * st.n;
  st.pad = (st.pad << 3) + (st.pad >> 29);
  st.n = st.pad | 2;
  st.d ^= (st.pad << 31) + (st.pad >> 1);
  st.dat ^= static_cast<uint8_t>(st.pad) ^ static_cast<uint8_t>(st.d >> 8) ^ 1;

  return st.pad ^ (st.d << 5) ^ (st.pad >> 18) ^ (static_cast<uint32_t>(st.dat) << 1);
}

YasmarangRng::YasmarangRng() : seeded_(false) {}

void YasmarangRng::reset_cold_start(uint32_t pad) {
  seeded_ = true;
  st_.pad = pad;
  st_.n = 0;
  st_.d = 0;
  st_.dat = 0;
}

uint32_t YasmarangRng::rng_get() {
  if (!seeded_) {
    seeded_ = true;
    st_.pad = 0;
    st_.n = 0;
    st_.d = 0;
    st_.dat = 0;
  }
  return yasmarang_step(st_);
}

LibnguYasmarang::LibnguYasmarang() {
  st_.pad = 0x0a8ce26f;
  st_.n = 69;
  st_.d = 233;
  st_.dat = 0;
}

uint32_t LibnguYasmarang::rng_get() { return yasmarang_step(st_); }

}  // namespace scanner
