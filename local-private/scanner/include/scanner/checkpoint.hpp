#pragma once

#include <cstdint>
#include <string>

namespace scanner {

struct CheckpointState {
  std::string run_id;
  std::string config_hash;
  uint64_t next_pad_index = 0;
  uint64_t pads_total = 0;
  uint64_t seeds_tested = 0;
  uint64_t hits = 0;
  double elapsed_sec = 0;
  std::string victim_snapshot_hash;
  int gpu_util_pct = 100;
};

bool save_checkpoint(const std::string& dir, const CheckpointState& state, std::string& error);
bool load_checkpoint(const std::string& dir, const std::string& run_id, CheckpointState& state, std::string& error);
std::string checkpoint_path(const std::string& dir, const std::string& run_id);

}  // namespace scanner
