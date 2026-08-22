#include "cuda/field.cuh"
#include "cuda/vanity_math.cuh"

namespace cuda_secp {

namespace {

__device__ __constant__ uint32_t SECP_P[8] = {0xFFFFFC2F, 0xFFFFFFFE, 0xFFFFFFFF, 0xFFFFFFFF,
                                            0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF};

__device__ __constant__ uint32_t SECP_GX[8] = {0x16F81798, 0x59F2815B, 0x2DCE28D9, 0x029BFCDB,
                                             0xCE870B07, 0x55A06295, 0xF9DCBBAC, 0x79BE667E};

__device__ __constant__ uint32_t SECP_GY[8] = {0xFB10D4B8, 0x9C47D08F, 0xA6855419, 0xFD17B448,
                                             0x0E1108A8, 0x5DA4FBFC, 0x26A3C465, 0x483ADA77};

__device__ __forceinline__ int u256_is_zero(const u256 a) {
  int z = 0;
  #pragma unroll
  for (int i = 0; i < 8; i++) z |= a[i];
  return z == 0;
}

__device__ void u256_sub(u256 r, const u256 a, const u256 b) {
  uint64_t borrow = 0;
  #pragma unroll
  for (int i = 0; i < 8; i++) {
    uint64_t av = a[i];
    uint64_t bv = b[i] + borrow;
    if (av < bv) {
      r[i] = (uint32_t)(av + (1ULL << 32) - bv);
      borrow = 1;
    } else {
      r[i] = (uint32_t)(av - bv);
      borrow = 0;
    }
  }
}

__device__ void u256_add_raw(u256 r, const u256 a, const u256 b) {
  uint64_t carry = 0;
  #pragma unroll
  for (int i = 0; i < 8; i++) {
    uint64_t s = (uint64_t)a[i] + b[i] + carry;
    r[i] = (uint32_t)s;
    carry = s >> 32;
  }
}

}  // namespace

__device__ bool u256_gte(const u256 a, const u256 b) {
  for (int i = 7; i >= 0; i--) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

__device__ void u256_from_be32(u256 r, const uint8_t be[32]) {
  for (int i = 0; i < 8; i++) {
    int o = (7 - i) * 4;
    r[i] = ((uint32_t)be[o] << 24) | ((uint32_t)be[o + 1] << 16) | ((uint32_t)be[o + 2] << 8) | be[o + 3];
  }
}

__device__ void u256_to_be32(uint8_t be[32], const u256 a) {
  for (int i = 0; i < 8; i++) {
    int o = (7 - i) * 4;
    be[o] = (uint8_t)(a[i] >> 24);
    be[o + 1] = (uint8_t)(a[i] >> 16);
    be[o + 2] = (uint8_t)(a[i] >> 8);
    be[o + 3] = (uint8_t)a[i];
  }
}

__device__ void u256_add(u256 r, const u256 a, const u256 b) {
  uint64_t carry = 0;
  #pragma unroll
  for (int i = 0; i < 8; i++) {
    uint64_t s = (uint64_t)a[i] + b[i] + carry;
    r[i] = (uint32_t)s;
    carry = s >> 32;
  }
  if (carry) {
    // (a + b) = r + 2^256; fold 2^256 mod p (= 0x1000003D1) into r.
    u256 n;
    u256_clear(n);
    n[0] = 0x3D1u;
    n[1] = 1u;
    u256 t;
    u256_add_raw(t, r, n);
    u256_copy(r, t);
  }
  if (u256_gte(r, SECP_P)) u256_sub(r, r, SECP_P);
}

__device__ void u256_sub_mod_p(u256 r, const u256 a, const u256 b) {
  if (u256_gte(a, b)) {
    u256_sub(r, a, b);
  } else {
    u256 t;
    u256_sub(t, SECP_P, b);
    u256_add(r, a, t);
  }
}

__device__ __forceinline__ bool u256_equal(const u256 a, const u256 b) {
  #pragma unroll
  for (int i = 0; i < 8; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

__device__ void u256_to_u64x4(uint64_t out[4], const u256 a) {
  #pragma unroll
  for (int i = 0; i < 4; i++) {
    out[i] = ((uint64_t)a[i * 2 + 1] << 32) | a[i * 2];
  }
}

__device__ void u256_from_u64x4(u256 r, const uint64_t in[4]) {
  #pragma unroll
  for (int i = 0; i < 4; i++) {
    r[i * 2] = (uint32_t)in[i];
    r[i * 2 + 1] = (uint32_t)(in[i] >> 32);
  }
  while (u256_gte(r, SECP_P)) u256_sub(r, r, SECP_P);
}

__device__ void u256_mul_mod_p(u256 r, const u256 a, const u256 b) {
  uint64_t ua[4], ub[4], ur[4];
  u256_to_u64x4(ua, a);
  u256_to_u64x4(ub, b);
  vanity_mod_mult(ur, ua, ub);
  u256_from_u64x4(r, ur);
}

namespace {

__device__ void u256_inv_mod_p(u256 r, const u256 a) {
  static const uint64_t EXP[4] = {0xFFFFFFFEFFFFFC2DULL, 0xFFFFFFFFFFFFFFFFULL, 0xFFFFFFFFFFFFFFFFULL,
                                  0xFFFFFFFFFFFFFFFFULL};
  uint64_t base[4], res[4] = {1, 0, 0, 0}, tmp[4];
  u256_to_u64x4(base, a);
  for (int limb = 3; limb >= 0; limb--) {
    uint64_t e = EXP[limb];
    for (int bit = 63; bit >= 0; bit--) {
      vanity_mod_mult(tmp, res, res);
      res[0] = tmp[0];
      res[1] = tmp[1];
      res[2] = tmp[2];
      res[3] = tmp[3];
      if ((e >> bit) & 1ULL) {
        vanity_mod_mult(tmp, res, base);
        res[0] = tmp[0];
        res[1] = tmp[1];
        res[2] = tmp[2];
        res[3] = tmp[3];
      }
    }
  }
  u256_from_u64x4(r, res);
}

struct AffinePoint {
  u256 x;
  u256 y;
  bool inf;
};

__device__ void affine_set_inf(AffinePoint& p) {
  u256_clear(p.x);
  u256_clear(p.y);
  p.inf = true;
}

__device__ void affine_set_g(AffinePoint& p) {
  u256_copy(p.x, SECP_GX);
  u256_copy(p.y, SECP_GY);
  p.inf = false;
}

__device__ void affine_double(AffinePoint& r, const AffinePoint& a) {
  if (a.inf) {
    affine_set_inf(r);
    return;
  }
  u256 lam, x3, y3, t1, t2, inv, two_y;
  u256_add(two_y, a.y, a.y);
  u256_inv_mod_p(inv, two_y);
  u256_mul_mod_p(t1, a.x, a.x);
  u256_add(lam, t1, t1);
  u256_add(lam, lam, t1);
  u256_mul_mod_p(lam, lam, inv);
  u256_mul_mod_p(t1, lam, lam);
  u256_add(t2, a.x, a.x);
  u256_sub_mod_p(x3, t1, t2);
  u256_sub_mod_p(t1, a.x, x3);
  u256_mul_mod_p(t2, lam, t1);
  u256_sub_mod_p(y3, t2, a.y);
  u256_copy(r.x, x3);
  u256_copy(r.y, y3);
  r.inf = false;
}

__device__ void affine_add(AffinePoint& r, const AffinePoint& a, const AffinePoint& b) {
  if (a.inf) {
    r = b;
    return;
  }
  if (b.inf) {
    r = a;
    return;
  }
  u256 h, s, lam, x3, y3, t1, t2, inv;
  u256_sub_mod_p(h, b.x, a.x);
  if (u256_is_zero(h)) {
    u256_sub_mod_p(s, b.y, a.y);
    if (u256_is_zero(s)) {
      affine_double(r, a);
      return;
    }
    affine_set_inf(r);
    return;
  }
  u256_sub_mod_p(s, b.y, a.y);
  u256_inv_mod_p(inv, h);
  u256_mul_mod_p(lam, s, inv);
  u256_mul_mod_p(t1, lam, lam);
  u256_sub_mod_p(x3, t1, a.x);
  u256_sub_mod_p(x3, x3, b.x);
  u256_sub_mod_p(t1, a.x, x3);
  u256_mul_mod_p(t2, lam, t1);
  u256_sub_mod_p(y3, t2, a.y);
  u256_copy(r.x, x3);
  u256_copy(r.y, y3);
  r.inf = false;
}

__device__ void affine_to_compressed(uint8_t out33[33], const AffinePoint& p) {
  if (p.inf) {
    out33[0] = 0x00;
    return;
  }
  u256_to_be32(out33 + 1, p.x);
  out33[0] = (p.y[0] & 1) ? 0x03 : 0x02;
}

}  // namespace

__device__ void point_set_infinity(Point& p) {
  u256_clear(p.x);
  u256_clear(p.y);
  u256_clear(p.z);
}

__device__ bool point_is_infinity(const Point& p) { return u256_is_zero(p.z); }

__device__ void point_double(Point& r, const Point& a) {
  AffinePoint aa, rr;
  if (point_is_infinity(a)) {
    affine_set_inf(aa);
  } else {
    u256 zinv, z2, z3;
    u256_inv_mod_p(zinv, a.z);
    u256_mul_mod_p(z2, zinv, zinv);
    u256_mul_mod_p(z3, z2, zinv);
    u256_mul_mod_p(aa.x, a.x, z2);
    u256_mul_mod_p(aa.y, a.y, z3);
    aa.inf = false;
  }
  affine_double(rr, aa);
  if (rr.inf) {
    point_set_infinity(r);
    return;
  }
  u256_copy(r.x, rr.x);
  u256_copy(r.y, rr.y);
  u256_clear(r.z);
  r.z[0] = 1;
}

__device__ void point_add_affine(Point& r, const Point& a, const u256 gx, const u256 gy) {
  AffinePoint aa, bb, rr;
  if (point_is_infinity(a)) {
    u256_copy(bb.x, gx);
    u256_copy(bb.y, gy);
    bb.inf = false;
  } else {
    u256 zinv, z2, z3;
    u256_inv_mod_p(zinv, a.z);
    u256_mul_mod_p(z2, zinv, zinv);
    u256_mul_mod_p(z3, z2, zinv);
    u256_mul_mod_p(aa.x, a.x, z2);
    u256_mul_mod_p(aa.y, a.y, z3);
    aa.inf = false;
    u256_copy(bb.x, gx);
    u256_copy(bb.y, gy);
    bb.inf = false;
  }
  affine_add(rr, aa, bb);
  if (rr.inf) {
    point_set_infinity(r);
    return;
  }
  u256_copy(r.x, rr.x);
  u256_copy(r.y, rr.y);
  u256_clear(r.z);
  r.z[0] = 1;
}

__device__ void point_to_compressed(uint8_t out33[33], const Point& p) {
  AffinePoint a;
  if (point_is_infinity(p)) {
    affine_set_inf(a);
  } else {
    u256 zinv, z2, z3;
    u256_inv_mod_p(zinv, p.z);
    u256_mul_mod_p(z2, zinv, zinv);
    u256_mul_mod_p(z3, z2, zinv);
    u256_mul_mod_p(a.x, p.x, z2);
    u256_mul_mod_p(a.y, p.y, z3);
    a.inf = false;
  }
  affine_to_compressed(out33, a);
}

__device__ void secp256k1_pubkey_create(uint8_t pubkey33[33], const uint8_t priv32[32]) {
  static const uint8_t SECP_N_BE[32] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
                                        0xFF, 0xFF, 0xFF, 0xFE, 0xBA, 0xAE, 0xDC, 0xE6, 0xAF, 0x48, 0xA0, 0x3B,
                                        0xBF, 0xD2, 0x5E, 0x8C, 0xD0, 0x36, 0x41, 0x41};
  uint8_t k[32];
  for (int i = 0; i < 32; i++) k[i] = priv32[i];
  int ge_n = 0;
  for (int i = 0; i < 32; i++) {
    if (k[i] > SECP_N_BE[i]) {
      ge_n = 1;
      break;
    }
    if (k[i] < SECP_N_BE[i]) {
      ge_n = -1;
      break;
    }
  }
  if (ge_n > 0) {
    int borrow = 0;
    for (int i = 31; i >= 0; i--) {
      int v = static_cast<int>(k[i]) - SECP_N_BE[i] - borrow;
      if (v < 0) {
        k[i] = static_cast<uint8_t>(v + 256);
        borrow = 1;
      } else {
        k[i] = static_cast<uint8_t>(v);
        borrow = 0;
      }
    }
  }

  AffinePoint r;
  affine_set_inf(r);
  AffinePoint g;
  affine_set_g(g);

  for (int byte_i = 0; byte_i < 32; byte_i++) {
    uint8_t b = k[byte_i];
    for (int bit = 7; bit >= 0; bit--) {
      affine_double(r, r);
      if ((b >> bit) & 1) {
        affine_add(r, r, g);
      }
    }
  }
  affine_to_compressed(pubkey33, r);
}

// Returns 0 on success, else error code (1=mul, 2=inv, 3=double-G, 5=inv(2y)).
__device__ int field_selftest_device() {
  u256 two, four, r, one;
  u256_clear(two);
  two[0] = 2;
  u256_mul_mod_p(four, two, two);
  u256_clear(r);
  r[0] = 4;
  if (!u256_equal(four, r)) return 1;

  u256 inv;
  u256_inv_mod_p(inv, two);
  u256_mul_mod_p(r, inv, two);
  u256_clear(one);
  one[0] = 1;
  if (!u256_equal(r, one)) return 2;

  AffinePoint g, g2;
  affine_set_g(g);
  u256 two_y, inv2y;
  u256_add(two_y, g.y, g.y);
  u256_inv_mod_p(inv2y, two_y);
  u256_mul_mod_p(r, inv2y, two_y);
  if (!u256_equal(r, one)) return 5;

  affine_double(g2, g);
  static const uint8_t k2Gx[32] = {0xc6, 0x04, 0x7f, 0x94, 0x41, 0xed, 0x7d, 0x6d, 0x30, 0x45, 0x40,
                                   0x6e, 0x95, 0xc0, 0x7c, 0xd8, 0x5c, 0x77, 0x8e, 0x4b, 0x8c, 0xef,
                                   0x3c, 0xa7, 0xab, 0xac, 0x09, 0xb9, 0x5c, 0x70, 0x9e, 0xe5};
  uint8_t xbe[32];
  u256_to_be32(xbe, g2.x);
  for (int i = 0; i < 32; i++) {
    if (xbe[i] != k2Gx[i]) return 3;
  }
  return 0;
}

}  // namespace cuda_secp
