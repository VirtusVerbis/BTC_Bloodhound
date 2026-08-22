#include "scanner/report.hpp"

#include "scanner/match_db.hpp"

#include <iostream>
#include <map>
#include <sqlite3.h>

namespace scanner {

static void print_histogram(sqlite3* db, int64_t run_id) {
  const char* sql =
      "SELECT s.seed_fingerprint, COUNT(m.id) AS cnt FROM seeds s "
      "JOIN matches m ON m.seed_id = s.id WHERE s.run_id = ? GROUP BY s.seed_fingerprint ORDER BY cnt DESC";
  sqlite3_stmt* stmt = nullptr;
  if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) return;
  sqlite3_bind_int64(stmt, 1, run_id);
  std::map<int, int> hist;
  int unique_seeds = 0;
  int total_matches = 0;
  while (sqlite3_step(stmt) == SQLITE_ROW) {
    const int cnt = sqlite3_column_int(stmt, 1);
    hist[cnt]++;
    unique_seeds++;
    total_matches += cnt;
  }
  sqlite3_finalize(stmt);
  std::cout << "unique_seeds: " << unique_seeds << "\n";
  std::cout << "total_matches: " << total_matches << "\n";
  if (unique_seeds > 0) {
    std::cout << "avg_addresses_per_seed: " << static_cast<double>(total_matches) / unique_seeds << "\n";
  }
  std::cout << "histogram (addresses_per_seed -> wallet_count):\n";
  for (const auto& [addrs, wallets] : hist) {
    std::cout << "  " << addrs << " -> " << wallets << "\n";
  }
}

int run_report_summary(MatchDb& db, const std::string& matches_db_path, const std::string& run_id, bool decrypt,
                       const std::string& key_file) {
  (void)decrypt;
  (void)key_file;
  std::string err;
  auto run = !run_id.empty() ? db.get_run(run_id, err) : db.get_latest_incomplete(err);
  if (!run) run = db.get_latest_run(err);
  if (!run) {
    std::cerr << "no run found\n";
    return 1;
  }

  std::cout << "run_id: " << run->run_id << "\n";
  std::cout << "status: " << run->status << "\n";
  std::cout << "pads_done: " << run->pads_done << "\n";
  std::cout << "seeds_tested: " << run->seeds_tested << "\n";
  std::cout << "hits: " << run->hits << "\n";

  // Access underlying sqlite via reopen — MatchDb does not expose handle
  sqlite3* sqlite = nullptr;
  if (sqlite3_open(matches_db_path.c_str(), &sqlite) == SQLITE_OK) {
    print_histogram(sqlite, run->id);
    sqlite3_close(sqlite);
  }
  return 0;
}

int run_report_by_seed(MatchDb& db, const std::string& matches_db_path, const std::string& run_id, bool decrypt,
                       const std::string& key_file) {
  (void)decrypt;
  (void)key_file;
  std::string err;
  auto run = !run_id.empty() ? db.get_run(run_id, err) : db.get_latest_incomplete(err);
  if (!run) run = db.get_latest_run(err);
  if (!run) {
    std::cerr << "no run found\n";
    return 1;
  }

  sqlite3* sqlite = nullptr;
  if (sqlite3_open(matches_db_path.c_str(), &sqlite) != SQLITE_OK) return 1;
  const char* sql =
      "SELECT s.seed_fingerprint, GROUP_CONCAT(m.victim_address, ', ') FROM seeds s "
      "JOIN matches m ON m.seed_id = s.id WHERE s.run_id = ? GROUP BY s.seed_fingerprint";
  sqlite3_stmt* stmt = nullptr;
  if (sqlite3_prepare_v2(sqlite, sql, -1, &stmt, nullptr) == SQLITE_OK) {
    sqlite3_bind_int64(stmt, 1, run->id);
    while (sqlite3_step(stmt) == SQLITE_ROW) {
      const char* fp = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 0));
      const char* victims = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
      std::cout << fp << " -> " << victims << "\n";
    }
    sqlite3_finalize(stmt);
  }
  sqlite3_close(sqlite);
  return 0;
}

}  // namespace scanner
