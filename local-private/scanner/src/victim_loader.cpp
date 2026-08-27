#include "scanner/victim_loader.hpp"

#include "scanner/crypto_aes.hpp"

#include <sqlite3.h>

#include <chrono>
#include <filesystem>
#include <iomanip>
#include <sstream>

namespace scanner {

bool normalize_bitcoin_address(const std::string& raw, std::string& out) {
  std::string a = raw;
  size_t start = 0;
  while (start < a.size() && a[start] == ' ') start++;
  size_t end = a.size();
  while (end > start && a[end - 1] == ' ') end--;
  a = a.substr(start, end - start);
  if (a.empty() || a.size() > 90) return false;
  if (a.rfind("bc1", 0) == 0 || a.rfind("BC1", 0) == 0) {
    for (char& c : a) c = static_cast<char>(tolower(static_cast<unsigned char>(c)));
    out = a;
    return true;
  }
  out = a;
  return !out.empty();
}

bool VictimSet::load_from_cointrace_db(const std::string& db_path, int max_age_hours, std::string& error) {
  if (!std::filesystem::exists(db_path)) {
    error = "cointrace db not found: " + db_path + " — run: pnpm db:pull-d1:remote";
    return false;
  }
  const auto ftime = std::filesystem::last_write_time(db_path);
  const auto sctp = std::chrono::time_point_cast<std::chrono::system_clock::duration>(
      ftime - std::filesystem::file_time_type::clock::now() + std::chrono::system_clock::now());
  const auto age_h = std::chrono::duration_cast<std::chrono::hours>(std::chrono::system_clock::now() - sctp).count();
  if (age_h > max_age_hours) {
    error = "warning: cointrace db is older than " + std::to_string(max_age_hours) +
            "h — consider: pnpm db:pull-d1:remote";
  }

  std::string uri = "file:" + db_path + "?mode=ro";
  sqlite3* db = nullptr;
  if (sqlite3_open_v2(uri.c_str(), &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nullptr) != SQLITE_OK) {
    error = std::string("sqlite open failed: ") + sqlite3_errmsg(db);
    sqlite3_close(db);
    return false;
  }

  const char* sql = "SELECT address FROM addresses WHERE role = 'victim' ORDER BY address";
  sqlite3_stmt* stmt = nullptr;
  if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
    error = sqlite3_errmsg(db);
    sqlite3_close(db);
    return false;
  }

  entries_.clear();
  hash160_list_.clear();
  lookup_keys_.clear();
  address_index_.clear();

  while (sqlite3_step(stmt) == SQLITE_ROW) {
    const char* addr = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
    if (!addr) continue;
    std::string normalized;
    if (!normalize_bitcoin_address(addr, normalized)) continue;

    VictimLookupKey lk;
    if (!address_to_lookup_key(normalized, lk)) continue;

    VictimEntry e;
    e.address = normalized;
    e.hash160 = lk.key20;
    lk.victim_index = static_cast<uint32_t>(entries_.size());
    address_index_[normalized] = entries_.size();
    entries_.push_back(e);
    hash160_list_.push_back(lk.key20);
    lookup_keys_.push_back(lk);
  }
  sqlite3_finalize(stmt);
  sqlite3_close(db);

  if (entries_.empty()) {
    error = "no victim addresses found in cointrace db";
    return false;
  }
  return true;
}

bool VictimSet::add_address(const std::string& address, std::string& error) {
  std::string normalized;
  if (!normalize_bitcoin_address(address, normalized)) {
    error = "invalid victim address: " + address;
    return false;
  }
  if (address_index_.find(normalized) != address_index_.end()) {
    error = "duplicate victim address: " + normalized;
    return false;
  }

  VictimLookupKey lk;
  if (!address_to_lookup_key(normalized, lk)) {
    error = "failed to decode victim address: " + normalized;
    return false;
  }

  VictimEntry e;
  e.address = normalized;
  e.hash160 = lk.key20;
  lk.victim_index = static_cast<uint32_t>(entries_.size());
  address_index_[normalized] = entries_.size();
  entries_.push_back(e);
  hash160_list_.push_back(lk.key20);
  lookup_keys_.push_back(lk);
  return true;
}

std::string VictimSet::snapshot_hash() const {
  std::string joined;
  for (const auto& e : entries_) {
    joined += e.address;
    joined += '\n';
  }
  return sha256_hex(joined);
}

const VictimEntry* VictimSet::find_by_address(const std::string& address) const {
  auto it = address_index_.find(address);
  if (it == address_index_.end()) return nullptr;
  return &entries_[it->second];
}

const VictimEntry* VictimSet::find_by_hash160(const uint8_t* h) const {
  if (!h) return nullptr;
  for (size_t i = 0; i < hash160_list_.size(); i++) {
    if (hash160_list_[i].size() == 20 && memcmp(hash160_list_[i].data(), h, 20) == 0) {
      return &entries_[i];
    }
  }
  return nullptr;
}

}  // namespace scanner
