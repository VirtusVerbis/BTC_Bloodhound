// MIT License - adapted secp256k1 field/point math for CUDA batch pubkey generation.
// Reference patterns from public Bitcoin CUDA projects (BitCrack-style, MIT).

#pragma once

#include <cuda_runtime.h>
#include <stdint.h>

namespace cuda_secp {

using u256 = uint32_t[8];  // little-endian limbs

__device__ __forceinline__ void u256_clear(u256 a) {
  #pragma unroll
  for (int i = 0; i < 8; i++) a[i] = 0;
}

__device__ __forceinline__ void u256_copy(u256 dst, const u256 src) {
  #pragma unroll
  for (int i = 0; i < 8; i++) dst[i] = src[i];
}

__device__ void u256_add(u256 r, const u256 a, const u256 b);
__device__ void u256_sub_mod_p(u256 r, const u256 a, const u256 b);
__device__ void u256_mul_mod_p(u256 r, const u256 a, const u256 b);
__device__ bool u256_gte(const u256 a, const u256 b);
__device__ void u256_from_be32(u256 r, const uint8_t be[32]);
__device__ void u256_to_be32(uint8_t be[32], const u256 a);

struct Point {
  u256 x;
  u256 y;
  u256 z;
};

__device__ void point_set_infinity(Point& p);
__device__ bool point_is_infinity(const Point& p);
__device__ void point_double(Point& r, const Point& a);
__device__ void point_add_affine(Point& r, const Point& a, const u256 gx, const u256 gy);
__device__ void point_to_compressed(uint8_t out33[33], const Point& p);

// pubkey33 = priv32 * G
__device__ void secp256k1_pubkey_create(uint8_t pubkey33[33], const uint8_t priv32[32]);

// 0=ok, else error code (see field.cu)
__device__ int field_selftest_device();

}  // namespace cuda_secp
