#pragma once

#include "cuda/sha512_device.cuh"

__device__ inline void hmac_sha512_device(const uint8_t* key, int key_len, const uint8_t* data, int data_len,
                                          uint8_t out64[64]) {
  uint8_t k_pad[128];
  for (int i = 0; i < 128; i++) k_pad[i] = 0;
  if (key_len > 128) {
    sha512_bytes(key, key_len, k_pad);
    key_len = 64;
  } else {
    for (int i = 0; i < key_len; i++) k_pad[i] = key[i];
  }

  uint8_t o_key_pad[128];
  uint8_t i_key_pad[128];
  for (int i = 0; i < 128; i++) {
    o_key_pad[i] = k_pad[i] ^ 0x5c;
    i_key_pad[i] = k_pad[i] ^ 0x36;
  }

  uint8_t inner[128 + 256];
  for (int i = 0; i < 128; i++) inner[i] = i_key_pad[i];
  for (int i = 0; i < data_len && i < 256; i++) inner[128 + i] = data[i];
  uint8_t inner_hash[64];
  sha512_bytes(inner, 128 + data_len, inner_hash);

  uint8_t outer[128 + 64];
  for (int i = 0; i < 128; i++) outer[i] = o_key_pad[i];
  for (int i = 0; i < 64; i++) outer[128 + i] = inner_hash[i];
  sha512_bytes(outer, 192, out64);
}
