#pragma once

#include <cstdint>

struct YasmarangDeviceState {
  uint32_t pad;
  uint32_t n;
  uint32_t d;
  uint8_t dat;
};

__device__ inline uint32_t yasmarang_device_step(YasmarangDeviceState& st) {
  st.pad += st.dat + st.d * st.n;
  st.pad = (st.pad << 3) + (st.pad >> 29);
  st.n = st.pad | 2;
  st.d ^= (st.pad << 31) + (st.pad >> 1);
  st.dat ^= static_cast<uint8_t>(st.pad) ^ static_cast<uint8_t>(st.d >> 8) ^ 1;
  return st.pad ^ (st.d << 5) ^ (st.pad >> 18) ^ (static_cast<uint32_t>(st.dat) << 1);
}

__device__ inline void yasmarang_mp_cold_start(YasmarangDeviceState& st, uint32_t pad) {
  st.pad = pad;
  st.n = 0;
  st.d = 0;
  st.dat = 0;
}

__device__ inline void yasmarang_libngu_mk3_init(YasmarangDeviceState& st) {
  st.pad = 0x0a8ce26f;
  st.n = 69;
  st.d = 233;
  st.dat = 0;
}

__device__ inline void my_random_bytes_device(YasmarangDeviceState& mp, YasmarangDeviceState& lib, uint8_t* dest,
                                              uint32_t count) {
  uint32_t last = 0;
  uint32_t offset = 0;
  while (offset < count) {
    uint32_t chip = yasmarang_device_step(mp);
    if (chip == last) continue;
    last = chip;
    chip ^= yasmarang_device_step(lib);
    const uint32_t here = count - offset < 4 ? count - offset : 4;
    for (uint32_t i = 0; i < here; i++) {
      dest[offset + i] = static_cast<uint8_t>(chip >> (8 * i));
    }
    offset += here;
  }
}
