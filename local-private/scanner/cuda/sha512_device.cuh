#pragma once

#include <cstdint>

__device__ inline uint64_t sha512_rotr64(uint64_t x, int n) { return (x >> n) | (x << (64 - n)); }
__device__ inline uint64_t sha512_shr64(uint64_t x, int n) { return x >> n; }

__device__ inline uint64_t sha512_ch(uint64_t x, uint64_t y, uint64_t z) { return (x & y) ^ (~x & z); }
__device__ inline uint64_t sha512_maj(uint64_t x, uint64_t y, uint64_t z) { return (x & y) ^ (x & z) ^ (y & z); }
__device__ inline uint64_t sha512_sigma0(uint64_t x) {
  return sha512_rotr64(x, 28) ^ sha512_rotr64(x, 34) ^ sha512_rotr64(x, 39);
}
__device__ inline uint64_t sha512_sigma1(uint64_t x) {
  return sha512_rotr64(x, 14) ^ sha512_rotr64(x, 18) ^ sha512_rotr64(x, 41);
}
__device__ inline uint64_t sha512_gamma0(uint64_t x) {
  return sha512_rotr64(x, 1) ^ sha512_rotr64(x, 8) ^ sha512_shr64(x, 7);
}
__device__ inline uint64_t sha512_gamma1(uint64_t x) {
  return sha512_rotr64(x, 19) ^ sha512_rotr64(x, 61) ^ sha512_shr64(x, 6);
}

__device__ inline void sha512_transform(uint64_t state[8], const uint8_t block[128]) {
  static const uint64_t K[80] = {
      0x428a2f98d728ae22ULL, 0x7137449123ef65cdULL, 0xb5c0fbcfec4d3b2fULL, 0xe9b5dba58189dbbcULL,
      0x3956c25bf348b538ULL, 0x59f111f1b605d019ULL, 0x923f82a4af194f9bULL, 0xab1c5ed5da6d8118ULL,
      0xd807aa98a3030242ULL, 0x12835b0145706fbeULL, 0x243185be4ee4b28cULL, 0x550c7dc3d5ffb4e2ULL,
      0x72be5d74f27b896fULL, 0x80deb1fe3b1696b1ULL, 0x9bdc06a725c71235ULL, 0xc19bf174cf692694ULL,
      0xe49b69c19ef14ad2ULL, 0xefbe4786384f25e3ULL, 0x0fc19dc68b8cd5b5ULL, 0x240ca1cc77ac9c65ULL,
      0x2de92c6f592b0275ULL, 0x4a7484aa6ea6e483ULL, 0x5cb0a9dcbd41fbd4ULL, 0x76f988da831153b5ULL,
      0x983e5152ee66dfabULL, 0xa831c66d2db43210ULL, 0xb00327c898fb213fULL, 0xbf597fc7beef0ee4ULL,
      0xc6e00bf33da88fc2ULL, 0xd5a79147930aa725ULL, 0x06ca6351e003826fULL, 0x142929670a0e6e70ULL,
      0x27b70a8546d22ffcULL, 0x2e1b21385c26c926ULL, 0x4d2c6dfc5ac42aedULL, 0x53380d139d95b3dfULL,
      0x650a73548baf63deULL, 0x766a0abb3c77b2a8ULL, 0x81c2c92e47edaee6ULL, 0x92722c851482353bULL,
      0xa2bfe8a14cf10364ULL, 0xa81a664bbc423001ULL, 0xc24b8b70d0f89791ULL, 0xc76c51a30654be30ULL,
      0xd192e819d6ef5218ULL, 0xd69906245565a910ULL, 0xf40e35855771202aULL, 0x106aa07032bbd1b8ULL,
      0x19a4c116b8d2d0c8ULL, 0x1e376c085141ab53ULL, 0x2748774cdf8eeb99ULL, 0x34b0bcb5e19b48a8ULL,
      0x391c0cb3c5c95a63ULL, 0x4ed8aa4ae3418acbULL, 0x5b9cca4f7763e373ULL, 0x682e6ff3d6b2b8a3ULL,
      0x748f82ee5defb2fcULL, 0x78a5636f43172f60ULL, 0x84c87814a1f0ab72ULL, 0x8cc702081a6439ecULL,
      0x90befffa23631e28ULL, 0xa4506cebde82bde9ULL, 0xbef9a3f7b2c67915ULL, 0xc67178f2e372532bULL,
      0xca273eceea26619cULL, 0xd186b8c721c0c207ULL, 0xeada7dd6cde0eb1eULL, 0xf57d4f7fee6ed178ULL,
      0x06f067aa72176fbaULL, 0x0a637dc5a2c898a6ULL, 0x113f9804bef90daeULL, 0x1b710b35131c471bULL,
      0x28db77f523047d84ULL, 0x32caab7b40c72493ULL, 0x3c9ebe0a15c9bebcULL, 0x431d67c49c100d4cULL,
      0x4cc5d4becb3e42b6ULL, 0x597f299cfc657e2aULL, 0x5fcb6fab3ad6faecULL, 0x6c44198c4a475817ULL};

  uint64_t w[80];
  for (int i = 0; i < 16; i++) {
    w[i] = ((uint64_t)block[i * 8] << 56) | ((uint64_t)block[i * 8 + 1] << 48) |
           ((uint64_t)block[i * 8 + 2] << 40) | ((uint64_t)block[i * 8 + 3] << 32) |
           ((uint64_t)block[i * 8 + 4] << 24) | ((uint64_t)block[i * 8 + 5] << 16) |
           ((uint64_t)block[i * 8 + 6] << 8) | (uint64_t)block[i * 8 + 7];
  }
  for (int i = 16; i < 80; i++) {
    w[i] = sha512_gamma1(w[i - 2]) + w[i - 7] + sha512_gamma0(w[i - 15]) + w[i - 16];
  }

  uint64_t a = state[0], b = state[1], c = state[2], d = state[3];
  uint64_t e = state[4], f = state[5], g = state[6], h = state[7];
  for (int i = 0; i < 80; i++) {
    uint64_t t1 = h + sha512_sigma1(e) + sha512_ch(e, f, g) + K[i] + w[i];
    uint64_t t2 = sha512_sigma0(a) + sha512_maj(a, b, c);
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

__device__ inline void sha512_bytes(const uint8_t* msg, int len, uint8_t out64[64]) {
  uint64_t state[8] = {0x6a09e667f3bcc908ULL, 0xbb67ae8584caa73bULL, 0x3c6ef372fe94f82bULL,
                       0xa54ff53a5f1d36f1ULL, 0x510e527fade682d1ULL, 0x9b05688c2b3e6c1fULL,
                       0x1f83d9abfb41bd6bULL, 0x5be0cd19137e2179ULL};

  uint8_t block[128];
  int offset = 0;
  while (len - offset >= 128) {
    sha512_transform(state, msg + offset);
    offset += 128;
  }
  int rem = len - offset;
  for (int i = 0; i < rem; i++) block[i] = msg[offset + i];
  block[rem] = 0x80;
  for (int i = rem + 1; i < 128; i++) block[i] = 0;
  if (rem >= 112) {
    sha512_transform(state, block);
    for (int i = 0; i < 128; i++) block[i] = 0;
  }
  uint64_t bitlen = (uint64_t)len * 8;
  block[127] = (uint8_t)(bitlen);
  block[126] = (uint8_t)(bitlen >> 8);
  block[125] = (uint8_t)(bitlen >> 16);
  block[124] = (uint8_t)(bitlen >> 24);
  block[123] = (uint8_t)(bitlen >> 32);
  block[122] = (uint8_t)(bitlen >> 40);
  block[121] = (uint8_t)(bitlen >> 48);
  block[120] = (uint8_t)(bitlen >> 56);
  sha512_transform(state, block);

  for (int i = 0; i < 8; i++) {
    out64[i * 8] = (uint8_t)(state[i] >> 56);
    out64[i * 8 + 1] = (uint8_t)(state[i] >> 48);
    out64[i * 8 + 2] = (uint8_t)(state[i] >> 40);
    out64[i * 8 + 3] = (uint8_t)(state[i] >> 32);
    out64[i * 8 + 4] = (uint8_t)(state[i] >> 24);
    out64[i * 8 + 5] = (uint8_t)(state[i] >> 16);
    out64[i * 8 + 6] = (uint8_t)(state[i] >> 8);
    out64[i * 8 + 7] = (uint8_t)(state[i]);
  }
}
