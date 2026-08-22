#pragma once

#include <optional>
#include <string>
#include <vector>

#include "scanner/types.hpp"

namespace scanner {

class MatchDb {
 public:
  bool open(const std::string& path, std::string& error);
  void close();

  bool init_schema(std::string& error);
  bool insert_victim_import(const std::string& snapshot_hash, size_t victim_count, std::string& error);

  int64_t create_scan_run(const std::string& run_id, const std::string& config_json, std::string& error);
  bool update_scan_run(int64_t run_id, uint64_t pads_done, uint64_t seeds_tested, uint64_t hits,
                       const std::string& status, std::string& error);

  int64_t upsert_seed(int64_t run_id, const std::string& fingerprint, uint32_t pad, uint32_t scan_session,
                      const std::vector<uint8_t>& encrypted_entropy, std::string& error);

  bool insert_match(int64_t seed_id, const std::string& victim_address, const std::string& derived_address,
                    const DerivationPath& path, std::string& error);

  struct RunSummary {
    int64_t id = 0;
    std::string run_id;
    std::string config_json;
    uint64_t pads_done = 0;
    uint64_t seeds_tested = 0;
    uint64_t hits = 0;
    std::string status;
  };

  std::optional<RunSummary> get_run(const std::string& run_id, std::string& error);
  std::optional<RunSummary> get_latest_incomplete(std::string& error);
  std::optional<RunSummary> get_latest_resumable(std::string& error);
  std::optional<RunSummary> get_latest_run(std::string& error);

 private:
  void* db_ = nullptr;  // sqlite3*
};

}  // namespace scanner
