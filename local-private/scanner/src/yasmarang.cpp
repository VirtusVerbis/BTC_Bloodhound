#include "scanner/yasmarang.hpp"

namespace scanner {

YasmarangRng::YasmarangRng() : seeded_(false), pad_(0), n_(0), d_(0), dat_(0) {}

void YasmarangRng::reset_cold_start(uint32_t pad) {
  seeded_ = true;
  pad_ = pad;
  n_ = 0;
  d_ = 0;
  dat_ = 0;
}

uint32_t YasmarangRng::rng_get() {
  if (!seeded_) {
    seeded_ = true;
    pad_ = 0;
    n_ = 0;
    d_ = 0;
    dat_ = 0;
  }

  pad_ += dat_ + d_ * n_;
  pad_ = (pad_ << 3) + (pad_ >> 29);
  n_ = pad_ | 2;
  d_ ^= (pad_ << 31) + (pad_ >> 1);
  dat_ ^= static_cast<uint8_t>(pad_) ^ static_cast<uint8_t>(d_ >> 8) ^ 1;

  return pad_ ^ (d_ << 5) ^ (pad_ >> 18) ^ (dat_ << 1);
}

}  // namespace scanner
