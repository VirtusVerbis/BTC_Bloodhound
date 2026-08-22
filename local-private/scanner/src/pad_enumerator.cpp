#include "scanner/pad_enumerator.hpp"

namespace scanner {

uint64_t PadEnumerator::total() const {
  if (high_max < high_min) return 0;
  return static_cast<uint64_t>(high_max - high_min + 1) * 65536ull;
}

uint32_t PadEnumerator::high_word(uint32_t pad) const { return pad >> 16; }

bool PadEnumerator::passes_filter(uint32_t pad) const {
  const uint32_t hw = high_word(pad);
  return hw >= filter_high_min && hw <= filter_high_max;
}

uint32_t PadEnumerator::at(uint64_t index) const {
  const uint64_t span = static_cast<uint64_t>(high_max - high_min + 1);
  const uint64_t low = index % 65536ull;
  const uint64_t high_offset = (index / 65536ull) % span;
  const uint32_t high = high_min + static_cast<uint32_t>(high_offset);
  return (high << 16) | static_cast<uint32_t>(low);
}

}  // namespace scanner
