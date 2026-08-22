#pragma once

#include <cstdint>

__device__ inline uint32_t hash160_rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

__device__ inline uint32_t hash160_rotl(uint32_t x, int n) { return (x << n) | (x >> (32 - n)); }

__device__ inline void hash160_sha256_transform(uint32_t state[8], const uint8_t block[64]) {
  static const uint32_t K[64] = {
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
  uint32_t w[64];
  for (int i = 0; i < 16; i++) {
    w[i] = (block[i * 4] << 24) | (block[i * 4 + 1] << 16) | (block[i * 4 + 2] << 8) | block[i * 4 + 3];
  }
  for (int i = 16; i < 64; i++) {
    uint32_t s0 = hash160_rotr(w[i - 15], 7) ^ hash160_rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
    uint32_t s1 = hash160_rotr(w[i - 2], 17) ^ hash160_rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }
  uint32_t a = state[0], b = state[1], c = state[2], d = state[3];
  uint32_t e = state[4], f = state[5], g = state[6], h = state[7];
  for (int i = 0; i < 64; i++) {
    uint32_t S1 = hash160_rotr(e, 6) ^ hash160_rotr(e, 11) ^ hash160_rotr(e, 25);
    uint32_t ch = (e & f) ^ ((~e) & g);
    uint32_t t1 = h + S1 + ch + K[i] + w[i];
    uint32_t S0 = hash160_rotr(a, 2) ^ hash160_rotr(a, 13) ^ hash160_rotr(a, 22);
    uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
    uint32_t t2 = S0 + maj;
    h = g;
    g = f;
    f = e;
    e = d + t1;
    d = c;
    c = b;
    b = a;
    a = t1 + t2;
  }
  state[0] += a;
  state[1] += b;
  state[2] += c;
  state[3] += d;
  state[4] += e;
  state[5] += f;
  state[6] += g;
  state[7] += h;
}

__device__ inline void hash160_sha256_bytes(const uint8_t* msg, int len, uint8_t out32[32]) {
  uint32_t state[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                       0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
  uint8_t block[64] = {0};
  for (int i = 0; i < len && i < 64; i++) block[i] = msg[i];
  block[len] = 0x80;
  uint64_t bitlen = (uint64_t)len * 8;
  block[63] = (uint8_t)(bitlen);
  block[62] = (uint8_t)(bitlen >> 8);
  block[61] = (uint8_t)(bitlen >> 16);
  block[60] = (uint8_t)(bitlen >> 24);
  hash160_sha256_transform(state, block);
  for (int i = 0; i < 8; i++) {
    out32[i * 4] = (state[i] >> 24) & 0xff;
    out32[i * 4 + 1] = (state[i] >> 16) & 0xff;
    out32[i * 4 + 2] = (state[i] >> 8) & 0xff;
    out32[i * 4 + 3] = state[i] & 0xff;
  }
}

__device__ inline uint32_t hash160_ripemd_f(int i, uint32_t x, uint32_t y, uint32_t z) {
  switch (i >> 4) {
    case 0:
      return x ^ y ^ z;
    case 1:
      return (x & y) | (~x & z);
    case 2:
      return (x | ~y) ^ z;
    case 3:
      return (x & z) | (y & ~z);
    case 4:
      return x ^ (y | ~z);
    default:
      return 0;
  }
}

__device__ inline void hash160_ripemd160_bytes(const uint8_t* msg, int len, uint8_t* out20) {
  uint8_t block[64] = {};
  for (int i = 0; i < len && i < 64; i++) block[i] = msg[i];
  block[len] = 0x80;
  const uint64_t bitlen = static_cast<uint64_t>(len) * 8;
  for (int i = 0; i < 8; i++) {
    block[56 + i] = static_cast<uint8_t>(bitlen >> (8 * i));
  }

  uint32_t schedule[16];
  for (int j = 0; j < 16; j++) {
    schedule[j] = block[j * 4] | (block[j * 4 + 1] << 8) | (block[j * 4 + 2] << 16) | (block[j * 4 + 3] << 24);
  }

  uint32_t state[5] = {0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0};
  uint32_t al = state[0], ar = state[0];
  uint32_t bl = state[1], br = state[1];
  uint32_t cl = state[2], cr = state[2];
  uint32_t dl = state[3], dr = state[3];
  uint32_t el = state[4], er = state[4];

  static const uint32_t KL[5] = {0x00000000, 0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xA953FD4E};
  static const uint32_t KR[5] = {0x50A28BE6, 0x5C4DD124, 0x6D703EF3, 0x7A6D76E9, 0x00000000};
  static const int RL[80] = {0,  1,  2,  3,  4,  5,  6,  7,  8,  9,  10, 11, 12, 13, 14, 15, 7,  4,  13, 1,  10, 6,
                             15, 3,  12, 0,  9,  5,  2,  14, 11, 8,  3,  10, 14, 4,  9,  15, 8,  1,  2,  7,  0,  6,  13,
                             11, 5,  12, 1,  9,  11, 10, 0,  8,  12, 4,  13, 3,  7,  15, 14, 5,  6,  2,  4,  0,  5,  9,
                             7,  12, 2,  10, 14, 1,  3,  8,  11, 6,  15, 13};
  static const int RR[80] = {5,  14, 7,  0,  9,  2,  11, 4,  13, 6,  15, 8,  1,  10, 3,  12, 6,  11, 3,  7,  0,  13, 5,
                             10, 14, 15, 8,  12, 4,  9,  1,  2,  15, 5,  1,  3,  7,  14, 6,  9,  11, 8,  12, 2,  10, 0,
                             4,  13, 8,  6,  4,  1,  3,  11, 15, 0,  5,  12, 2,  13, 9,  7,  10, 14, 12, 15, 10, 4,  1,
                             5,  8,  7,  6,  2,  13, 14, 0,  3,  9,  11};
  static const int SL[80] = {11, 14, 15, 12, 5,  8,  7,  9,  11, 13, 14, 15, 6,  7,  9,  8,  7,  6,  8,  13, 11, 9,  7,
                             15, 7,  12, 15, 9,  11, 7,  13, 12, 11, 13, 6,  7,  14, 9,  13, 15, 14, 8,  13, 6,  5,  12,
                             7,  5,  11, 12, 14, 15, 14, 15, 9,  8,  9,  14, 5,  6,  8,  6,  5,  12, 9,  15, 5,  11, 6,
                             8,  13, 12, 5,  12, 13, 14, 11, 8,  5,  6};
  static const int SR[80] = {8,  9,  9,  11, 13, 15, 15, 5,  7,  7,  8,  11, 14, 14, 12, 6,  9,  13, 15, 7,  12, 8,  9,
                             11, 7,  7,  12, 7,  6,  15, 13, 11, 9,  7,  15, 11, 8,  6,  6,  14, 12, 13, 5,  14, 13, 13,
                             7,  5,  15, 5,  8,  11, 14, 14, 6,  14, 6,  9,  12, 9,  12, 5,  15, 8,  8,  5,  12, 9,  12,
                             5,  14, 6,  8,  13, 6,  5,  15, 13, 11, 11};

  for (int j = 0; j < 80; j++) {
    uint32_t temp = hash160_rotl(al + hash160_ripemd_f(j, bl, cl, dl) + schedule[RL[j]] + KL[j >> 4], SL[j]) + el;
    al = el;
    el = dl;
    dl = hash160_rotl(cl, 10);
    cl = bl;
    bl = temp;

    temp = hash160_rotl(ar + hash160_ripemd_f(79 - j, br, cr, dr) + schedule[RR[j]] + KR[j >> 4], SR[j]) + er;
    ar = er;
    er = dr;
    dr = hash160_rotl(cr, 10);
    cr = br;
    br = temp;
  }

  uint32_t t = state[1] + cl + dr;
  state[1] = state[2] + dl + er;
  state[2] = state[3] + el + ar;
  state[3] = state[4] + al + br;
  state[4] = state[0] + bl + cr;
  state[0] = t;

  for (int i = 0; i < 5; i++) {
    out20[i * 4] = (uint8_t)(state[i]);
    out20[i * 4 + 1] = (uint8_t)(state[i] >> 8);
    out20[i * 4 + 2] = (uint8_t)(state[i] >> 16);
    out20[i * 4 + 3] = (uint8_t)(state[i] >> 24);
  }
}

__device__ inline void hash160_ripemd160_32(const uint8_t in32[32], uint8_t out20[20]) {
  hash160_ripemd160_bytes(in32, 32, out20);
}

__device__ inline void hash160_pubkey_lookup(const uint8_t pub33[33], uint8_t family, uint8_t out20[20]) {
  uint8_t sha[32];
  hash160_sha256_bytes(pub33, 33, sha);
  uint8_t pk_hash[20];
  hash160_ripemd160_32(sha, pk_hash);
  if (family == 1) {
    uint8_t redeem[22] = {0x00, 0x14};
    for (int i = 0; i < 20; i++) redeem[2 + i] = pk_hash[i];
    hash160_sha256_bytes(redeem, 22, sha);
    hash160_ripemd160_bytes(sha, 32, out20);
  } else {
    for (int i = 0; i < 20; i++) out20[i] = pk_hash[i];
  }
}
