#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "scanner/gpu_types.hpp"
#include "scanner/types.hpp"
#include "scanner/victim_loader.hpp"

namespace scanner {

class GpuEngine {
 public:
  GpuEngine();
  ~GpuEngine();

  GpuEngine(const GpuEngine&) = delete;
  GpuEngine& operator=(const GpuEngine&) = delete;

  static bool probe_device(int device_index, std::string& name_out, size_t& vram_mb_out, std::string& error);

  bool init(int device_index, const VictimSet& victims, const std::vector<DerivationPath>& paths, std::string& error);

  void set_utilization_cap(int pct);

  // masters: seeds.size() * 64 bytes (priv32 + chain32 per seed)
  bool process_master_batch(const std::vector<SeedCandidate>& seeds, const std::vector<uint8_t>& masters,
                            std::vector<GpuHit>& hits, std::string& error);

  // privkeys: seeds.size() * path_count * 32 bytes, row-major [seed][path]
  bool process_privkey_batch(const std::vector<SeedCandidate>& seeds, const std::vector<uint8_t>& privkeys,
                             std::vector<GpuHit>& hits, std::string& error);

  double last_batch_checks_per_sec() const { return last_checks_per_sec_; }

  bool is_initialized() const { return initialized_; }

  size_t path_count() const { return path_count_; }

 private:
  struct Impl;
  Impl* impl_ = nullptr;
  bool initialized_ = false;
  int util_pct_ = 100;
  double last_checks_per_sec_ = 0;
  size_t path_count_ = 0;
};

}  // namespace scanner
