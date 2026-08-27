#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <string>

#include "scanner/console_style.hpp"
#include "scanner/match_db.hpp"
#include "scanner/types.hpp"
#include "scanner/victim_loader.hpp"

namespace scanner {

struct OrchestratorOptions {
  ScanConfig config;
  std::string run_id;
  std::string matches_db_path;
  std::string checkpoint_dir;
  std::string key_file;
  bool resume = false;
  bool fresh = false;
  bool backfill = false;
  std::string backfill_from_run_id;
  uint64_t backfill_to = 0;  // 0 = use source next_pad_index
  bool preflight_only = false;
  bool no_color = false;
  bool no_eta = false;
  bool show_privkey_hints = false;
  int gpu_util_override = -1;  // -1 = use config
  uint64_t pad_start = 0;
  uint64_t pad_end = 0;  // 0 = full range
};

class Orchestrator {
 public:
  int run_preflight(const OrchestratorOptions& opts);
  int run_scan(const OrchestratorOptions& opts);
  int run_benchmark(const OrchestratorOptions& opts);

 private:
  ConsoleStyle style_;
};

}  // namespace scanner
