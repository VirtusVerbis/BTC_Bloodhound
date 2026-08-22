#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace scanner {

struct DerivationPath {
  std::string script_type;  // bip84, bip49, bip44
  uint32_t account = 0;
  uint32_t branch = 0;  // 0 receive, 1 change
  uint32_t index = 0;
};

struct ScanConfig {
  uint32_t pad_high_min = 0;
  uint32_t pad_high_max = 89;
  uint32_t pad_high_filter_min = 0;
  uint32_t pad_high_filter_max = 89;
  uint32_t scan_session_min = 8;
  uint32_t scan_session_max = 60;

  uint32_t bip84_accounts_min = 0;
  uint32_t bip84_accounts_max = 2;
  uint32_t bip84_receive_min = 0;
  uint32_t bip84_receive_max = 100;
  uint32_t bip84_change_min = 0;
  uint32_t bip84_change_max = 50;
  uint32_t bip49_receive_min = 0;
  uint32_t bip49_receive_max = 40;
  uint32_t bip44_receive_min = 0;
  uint32_t bip44_receive_max = 20;

  int gpu_device_index = 0;
  int gpu_util_pct = 100;
  int base_batch_seeds = 512;
  int max_cuda_streams = 3;

  int progress_interval_sec = 60;
  bool show_live_matches = true;
  int abbrev_len = 6;
  bool color_enabled = true;
  double eta_smoothing_alpha = 0.2;
  bool show_eta = true;

  std::string cointrace_db_path = "../../data/cointrace.db";
  int cointrace_db_max_age_hours = 48;
};

struct MatchHit {
  uint32_t pad = 0;
  uint32_t scan_session = 0;
  std::string seed_fingerprint;
  std::vector<uint8_t> seed_entropy;
  DerivationPath path;
  std::string derived_address;
  std::string victim_address;
};

}  // namespace scanner
