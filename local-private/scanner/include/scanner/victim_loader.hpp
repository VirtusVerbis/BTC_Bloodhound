#pragma once

#include <string>
#include <unordered_map>
#include <vector>

#include "scanner/gpu_types.hpp"

namespace scanner {

struct VictimEntry {
  std::string address;
  std::vector<uint8_t> hash160;  // 20 bytes
};

class VictimSet {
 public:
  bool load_from_cointrace_db(const std::string& db_path, int max_age_hours, std::string& error);
  bool add_address(const std::string& address, std::string& error);
  size_t size() const { return entries_.size(); }
  const std::vector<VictimEntry>& entries() const { return entries_; }
  const std::vector<std::vector<uint8_t>>& hash160_list() const { return hash160_list_; }
  const std::vector<VictimLookupKey>& lookup_keys() const { return lookup_keys_; }
  std::string snapshot_hash() const;

  // Lookup address by hash160 (hex key)
  const VictimEntry* find_by_hash160(const uint8_t* h) const;
  const VictimEntry* find_by_address(const std::string& address) const;

 private:
  std::vector<VictimEntry> entries_;
  std::vector<std::vector<uint8_t>> hash160_list_;
  std::vector<VictimLookupKey> lookup_keys_;
  std::unordered_map<std::string, size_t> address_index_;
};

bool normalize_bitcoin_address(const std::string& raw, std::string& out);
bool address_to_lookup_key(const std::string& address, VictimLookupKey& out);
bool address_to_hash160(const std::string& address, std::vector<uint8_t>& hash160);

}  // namespace scanner
