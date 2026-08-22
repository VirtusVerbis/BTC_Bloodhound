#pragma once

#include <cstdint>

#define UADDO(c, a, b) asm volatile("add.cc.u64 %0, %1, %2;" : "=l"(c) : "l"(a), "l"(b) : "memory");
#define UADDC(c, a, b) asm volatile("addc.cc.u64 %0, %1, %2;" : "=l"(c) : "l"(a), "l"(b) : "memory");
#define UADD(c, a, b) asm volatile("addc.u64 %0, %1, %2;" : "=l"(c) : "l"(a), "l"(b));

#define UADDO1(c, a) asm volatile("add.cc.u64 %0, %0, %1;" : "+l"(c) : "l"(a) : "memory");
#define UADDC1(c, a) asm volatile("addc.cc.u64 %0, %0, %1;" : "+l"(c) : "l"(a) : "memory");
#define UADD1(c, a) asm volatile("addc.u64 %0, %0, %1;" : "+l"(c) : "l"(a));

#define UMULLO(lo, a, b) asm volatile("mul.lo.u64 %0, %1, %2;" : "=l"(lo) : "l"(a), "l"(b));
#define UMULHI(hi, a, b) asm volatile("mul.hi.u64 %0, %1, %2;" : "=l"(hi) : "l"(a), "l"(b));
#define MADDO(r, a, b, c) asm volatile("mad.hi.cc.u64 %0, %1, %2, %3;" : "=l"(r) : "l"(a), "l"(b), "l"(c) : "memory");
#define MADDC(r, a, b, c) asm volatile("madc.hi.cc.u64 %0, %1, %2, %3;" : "=l"(r) : "l"(a), "l"(b), "l"(c) : "memory");
#define MADD(r, a, b, c) asm volatile("madc.hi.u64 %0, %1, %2, %3;" : "=l"(r) : "l"(a), "l"(b), "l"(c));

#define UMult(r, a, b)     \
  {                        \
    UMULLO(r[0], a[0], b); \
    UMULLO(r[1], a[1], b); \
    MADDO(r[1], a[0], b, r[1]); \
    UMULLO(r[2], a[2], b); \
    MADDC(r[2], a[1], b, r[2]); \
    UMULLO(r[3], a[3], b); \
    MADDC(r[3], a[2], b, r[3]); \
    MADD(r[4], a[3], b, 0ULL); \
  }

__device__ __forceinline__ void vanity_mod_mult(uint64_t* r, const uint64_t* a, const uint64_t* b) {
  uint64_t r512[8];
  uint64_t t[5];
  uint64_t ah, al;

  r512[5] = 0;
  r512[6] = 0;
  r512[7] = 0;

  UMult(r512, a, b[0]);
  UMult(t, a, b[1]);
  UADDO1(r512[1], t[0]);
  UADDC1(r512[2], t[1]);
  UADDC1(r512[3], t[2]);
  UADDC1(r512[4], t[3]);
  UADD1(r512[5], t[4]);
  UMult(t, a, b[2]);
  UADDO1(r512[2], t[0]);
  UADDC1(r512[3], t[1]);
  UADDC1(r512[4], t[2]);
  UADDC1(r512[5], t[3]);
  UADD1(r512[6], t[4]);
  UMult(t, a, b[3]);
  UADDO1(r512[3], t[0]);
  UADDC1(r512[4], t[1]);
  UADDC1(r512[5], t[2]);
  UADDC1(r512[6], t[3]);
  UADD1(r512[7], t[4]);

  UMult(t, (r512 + 4), 0x1000003D1ULL);
  UADDO1(r512[0], t[0]);
  UADDC1(r512[1], t[1]);
  UADDC1(r512[2], t[2]);
  UADDC1(r512[3], t[3]);

  UADD1(t[4], 0ULL);
  UMULLO(al, t[4], 0x1000003D1ULL);
  UMULHI(ah, t[4], 0x1000003D1ULL);
  UADDO(r[0], r512[0], al);
  UADDC(r[1], r512[1], ah);
  UADDC(r[2], r512[2], 0ULL);
  UADD(r[3], r512[3], 0ULL);
}
