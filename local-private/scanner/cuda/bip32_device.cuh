#pragma once

#include "cuda/field.cuh"
#include "cuda/gpu_api.h"
#include "cuda/hmac_sha512_device.cuh"

namespace cuda_bip32 {

__device__ inline void add_mod_n(uint8_t out32[32], const uint8_t a32[32], const uint8_t b32[32]) {
  static const uint8_t SECP_N_BE[32] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
                                        0xFF, 0xFF, 0xFF, 0xFE, 0xBA, 0xAE, 0xDC, 0xE6, 0xAF, 0x48, 0xA0, 0x3B,
                                        0xBF, 0xD2, 0x5E, 0x8C, 0xD0, 0x36, 0x41, 0x41};
  static const uint8_t TWO256_MOD_N[32] = {0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                                           0x00, 0x00, 0x00, 0x01, 0x45, 0x51, 0x23, 0x19, 0x50, 0xb7, 0x5f, 0xc4,
                                           0x40, 0x2d, 0xa1, 0x73, 0x2f, 0xc9, 0xbe, 0xbf};

  uint8_t sum[32];
  uint16_t carry = 0;
  for (int i = 31; i >= 0; i--) {
    const uint16_t t = static_cast<uint16_t>(a32[i]) + b32[i] + carry;
    sum[i] = static_cast<uint8_t>(t);
    carry = t >> 8;
  }
  if (carry) {
    carry = 0;
    for (int i = 31; i >= 0; i--) {
      const uint16_t t = static_cast<uint16_t>(sum[i]) + TWO256_MOD_N[i] + carry;
      sum[i] = static_cast<uint8_t>(t);
      carry = t >> 8;
    }
  }

  int cmp = 0;
  for (int i = 0; i < 32; i++) {
    if (sum[i] > SECP_N_BE[i]) {
      cmp = 1;
      break;
    }
    if (sum[i] < SECP_N_BE[i]) {
      cmp = -1;
      break;
    }
  }
  if (cmp < 0) {
    for (int i = 0; i < 32; i++) out32[i] = sum[i];
    return;
  }
  int borrow = 0;
  for (int i = 31; i >= 0; i--) {
    const int v = static_cast<int>(sum[i]) - SECP_N_BE[i] - borrow;
    if (v < 0) {
      out32[i] = static_cast<uint8_t>(v + 256);
      borrow = 1;
    } else {
      out32[i] = static_cast<uint8_t>(v);
      borrow = 0;
    }
  }
}

__device__ inline void derive_child(uint8_t priv32[32], uint8_t chain32[32], uint32_t child_index, bool hardened) {
  const uint32_t idx = hardened ? (child_index | 0x80000000u) : child_index;
  uint8_t data[37];
  int data_len = 0;
  if (hardened) {
    data[0] = 0;
    for (int i = 0; i < 32; i++) data[1 + i] = priv32[i];
    data_len = 33;
  } else {
    uint8_t pub33[33];
    cuda_secp::secp256k1_pubkey_create(pub33, priv32);
    for (int i = 0; i < 33; i++) data[i] = pub33[i];
    data_len = 33;
  }
  data[data_len++] = (uint8_t)((idx >> 24) & 0xff);
  data[data_len++] = (uint8_t)((idx >> 16) & 0xff);
  data[data_len++] = (uint8_t)((idx >> 8) & 0xff);
  data[data_len++] = (uint8_t)(idx & 0xff);

  uint8_t mac[64];
  hmac_sha512_device(chain32, 32, data, data_len, mac);
  uint8_t child_priv[32];
  add_mod_n(child_priv, mac, priv32);
  for (int i = 0; i < 32; i++) priv32[i] = child_priv[i];
  for (int i = 0; i < 32; i++) chain32[i] = mac[32 + i];
}

__device__ inline void derive_child_with_pub(uint8_t priv32[32], uint8_t chain32[32], const uint8_t parent_pub33[33],
                                             uint32_t child_index) {
  const uint32_t idx = child_index;
  uint8_t data[37];
  for (int i = 0; i < 33; i++) data[i] = parent_pub33[i];
  data[33] = (uint8_t)((idx >> 24) & 0xff);
  data[34] = (uint8_t)((idx >> 16) & 0xff);
  data[35] = (uint8_t)((idx >> 8) & 0xff);
  data[36] = (uint8_t)(idx & 0xff);

  uint8_t mac[64];
  hmac_sha512_device(chain32, 32, data, 37, mac);
  uint8_t child_priv[32];
  add_mod_n(child_priv, mac, priv32);
  for (int i = 0; i < 32; i++) priv32[i] = child_priv[i];
  for (int i = 0; i < 32; i++) chain32[i] = mac[32 + i];
}

__device__ inline void derive_prefix_from_master(const uint8_t master64[64], const CudaPrefixDesc& prefix,
                                                 uint8_t out_priv32[32], uint8_t out_chain32[32],
                                                 uint8_t out_pub33[33]) {
  uint8_t priv32[32];
  uint8_t chain32[32];
  for (int i = 0; i < 32; i++) {
    priv32[i] = master64[i];
    chain32[i] = master64[32 + i];
  }
  for (int step = 0; step < 4; step++) {
    derive_child(priv32, chain32, prefix.step_index[step], prefix.step_hardened[step] != 0);
  }
  for (int i = 0; i < 32; i++) {
    out_priv32[i] = priv32[i];
    out_chain32[i] = chain32[i];
  }
  cuda_secp::secp256k1_pubkey_create(out_pub33, priv32);
}

__device__ inline void derive_leaf_from_prefix(const uint8_t prefix_priv32[32], const uint8_t prefix_chain32[32],
                                               const uint8_t prefix_pub33[33], uint32_t step4_index,
                                               uint8_t out_priv32[32]) {
  uint8_t priv32[32];
  uint8_t chain32[32];
  for (int i = 0; i < 32; i++) {
    priv32[i] = prefix_priv32[i];
    chain32[i] = prefix_chain32[i];
  }
  derive_child_with_pub(priv32, chain32, prefix_pub33, step4_index);
  for (int i = 0; i < 32; i++) out_priv32[i] = priv32[i];
}

__device__ inline void derive_path_from_master(const uint8_t master64[64], const CudaPathDesc& path,
                                               uint8_t out_priv32[32]) {
  uint8_t priv32[32];
  uint8_t chain32[32];
  for (int i = 0; i < 32; i++) {
    priv32[i] = master64[i];
    chain32[i] = master64[32 + i];
  }
  for (int step = 0; step < 5; step++) {
    derive_child(priv32, chain32, path.step_index[step], path.step_hardened[step] != 0);
  }
  for (int i = 0; i < 32; i++) out_priv32[i] = priv32[i];
}

__device__ inline void derive_path_from_master_steps(const uint8_t master64[64], const CudaPathDesc& path,
                                                     int num_steps, uint8_t out_priv32[32]) {
  uint8_t priv32[32];
  uint8_t chain32[32];
  for (int i = 0; i < 32; i++) {
    priv32[i] = master64[i];
    chain32[i] = master64[32 + i];
  }
  if (num_steps > 5) num_steps = 5;
  for (int step = 0; step < num_steps; step++) {
    derive_child(priv32, chain32, path.step_index[step], path.step_hardened[step] != 0);
  }
  for (int i = 0; i < 32; i++) out_priv32[i] = priv32[i];
}

}  // namespace cuda_bip32
