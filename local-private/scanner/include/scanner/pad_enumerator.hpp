#pragma once

#include <cstdint>

namespace scanner {

constexpr uint64_t kPadImageTotal = 68ull * 65536ull;

struct PadEnumerator {
  uint32_t high_min = 0;
  uint32_t high_max = 67;
  uint32_t filter_high_min = 0;
  uint32_t filter_high_max = 67;

  uint64_t total() const;
  uint32_t at(uint64_t index) const;
  uint32_t high_word(uint32_t pad) const;
  bool passes_filter(uint32_t pad) const;
};

}  // namespace scanner
