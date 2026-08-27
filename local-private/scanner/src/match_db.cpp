#include "scanner/match_db.hpp"

#include <sqlite3.h>

#include <cstring>

namespace scanner {

bool is_backfill_run_id(const std::string& run_id) {
  return run_id.rfind("backfill-for-", 0) == 0;
}

bool MatchDb::open(const std::string& path, std::string& error) {
  sqlite3* db = nullptr;
  if (sqlite3_open(path.c_str(), &db) != SQLITE_OK) {
    error = sqlite3_errmsg(db);
    sqlite3_close(db);
    return false;
  }
  db_ = db;
  return init_schema(error);
}

void MatchDb::close() {
  if (db_) {
    sqlite3_close(static_cast<sqlite3*>(db_));
    db_ = nullptr;
  }
}

bool MatchDb::init_schema(std::string& error) {
  auto* db = static_cast<sqlite3*>(db_);
  const char* sql =
      "CREATE TABLE IF NOT EXISTS scan_runs ("
      "id INTEGER PRIMARY KEY AUTOINCREMENT,"
      "run_id TEXT UNIQUE NOT NULL,"
      "started_at TEXT NOT NULL,"
      "config_json TEXT NOT NULL,"
      "pads_done INTEGER NOT NULL DEFAULT 0,"
      "seeds_tested INTEGER NOT NULL DEFAULT 0,"
      "hits INTEGER NOT NULL DEFAULT 0,"
      "status TEXT NOT NULL"
      ");"
      "CREATE TABLE IF NOT EXISTS seeds ("
      "id INTEGER PRIMARY KEY AUTOINCREMENT,"
      "run_id INTEGER NOT NULL,"
      "seed_fingerprint TEXT NOT NULL,"
      "pad INTEGER NOT NULL,"
      "scan_session INTEGER NOT NULL,"
      "encrypted_entropy BLOB NOT NULL,"
      "UNIQUE(run_id, seed_fingerprint)"
      ");"
      "CREATE TABLE IF NOT EXISTS matches ("
      "id INTEGER PRIMARY KEY AUTOINCREMENT,"
      "seed_id INTEGER NOT NULL,"
      "victim_address TEXT NOT NULL,"
      "derived_address TEXT NOT NULL,"
      "script_type TEXT NOT NULL,"
      "account INTEGER NOT NULL,"
      "branch INTEGER NOT NULL,"
      "address_index INTEGER NOT NULL"
      ");"
      "CREATE TABLE IF NOT EXISTS victim_imports ("
      "id INTEGER PRIMARY KEY AUTOINCREMENT,"
      "imported_at TEXT NOT NULL,"
      "snapshot_hash TEXT NOT NULL,"
      "victim_count INTEGER NOT NULL"
      ");";

  char* err = nullptr;
  if (sqlite3_exec(db, sql, nullptr, nullptr, &err) != SQLITE_OK) {
    error = err ? err : "schema init failed";
    sqlite3_free(err);
    return false;
  }
  const char* idx_sql =
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_seed_victim_derived "
      "ON matches(seed_id, victim_address, derived_address);";
  if (sqlite3_exec(db, idx_sql, nullptr, nullptr, &err) != SQLITE_OK) {
    error = err ? err : "schema index failed";
    sqlite3_free(err);
    return false;
  }
  return true;
}

bool MatchDb::insert_victim_import(const std::string& snapshot_hash, size_t victim_count, std::string& error) {
  auto* db = static_cast<sqlite3*>(db_);
  sqlite3_stmt* stmt = nullptr;
  const char* sql = "INSERT INTO victim_imports (imported_at, snapshot_hash, victim_count) VALUES (datetime('now'), ?, ?)";
  if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
    error = sqlite3_errmsg(db);
    return false;
  }
  sqlite3_bind_text(stmt, 1, snapshot_hash.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int64(stmt, 2, static_cast<int64_t>(victim_count));
  if (sqlite3_step(stmt) != SQLITE_DONE) {
    error = sqlite3_errmsg(db);
    sqlite3_finalize(stmt);
    return false;
  }
  sqlite3_finalize(stmt);
  return true;
}

int64_t MatchDb::create_scan_run(const std::string& run_id, const std::string& config_json, std::string& error) {
  auto* db = static_cast<sqlite3*>(db_);
  sqlite3_stmt* stmt = nullptr;
  const char* sql =
      "INSERT INTO scan_runs (run_id, started_at, config_json, status) VALUES (?, datetime('now'), ?, 'running')";
  if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
    error = sqlite3_errmsg(db);
    return -1;
  }
  sqlite3_bind_text(stmt, 1, run_id.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 2, config_json.c_str(), -1, SQLITE_TRANSIENT);
  if (sqlite3_step(stmt) != SQLITE_DONE) {
    error = sqlite3_errmsg(db);
    sqlite3_finalize(stmt);
    return -1;
  }
  sqlite3_finalize(stmt);
  return sqlite3_last_insert_rowid(db);
}

bool MatchDb::update_scan_run(int64_t run_id, uint64_t pads_done, uint64_t seeds_tested, uint64_t hits,
                              const std::string& status, std::string& error) {
  auto* db = static_cast<sqlite3*>(db_);
  sqlite3_stmt* stmt = nullptr;
  const char* sql =
      "UPDATE scan_runs SET pads_done=?, seeds_tested=?, hits=?, status=? WHERE id=?";
  if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
    error = sqlite3_errmsg(db);
    return false;
  }
  sqlite3_bind_int64(stmt, 1, static_cast<int64_t>(pads_done));
  sqlite3_bind_int64(stmt, 2, static_cast<int64_t>(seeds_tested));
  sqlite3_bind_int64(stmt, 3, static_cast<int64_t>(hits));
  sqlite3_bind_text(stmt, 4, status.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int64(stmt, 5, run_id);
  if (sqlite3_step(stmt) != SQLITE_DONE) {
    error = sqlite3_errmsg(db);
    sqlite3_finalize(stmt);
    return false;
  }
  sqlite3_finalize(stmt);
  return true;
}

int64_t MatchDb::upsert_seed(int64_t run_id, const std::string& fingerprint, uint32_t pad, uint32_t scan_session,
                             const std::vector<uint8_t>& encrypted_entropy, std::string& error) {
  auto* db = static_cast<sqlite3*>(db_);
  sqlite3_stmt* stmt = nullptr;
  const char* sql =
      "INSERT INTO seeds (run_id, seed_fingerprint, pad, scan_session, encrypted_entropy) VALUES (?,?,?,?,?)"
      " ON CONFLICT(run_id, seed_fingerprint) DO UPDATE SET encrypted_entropy=excluded.encrypted_entropy";
  if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
    error = sqlite3_errmsg(db);
    return -1;
  }
  sqlite3_bind_int64(stmt, 1, run_id);
  sqlite3_bind_text(stmt, 2, fingerprint.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int(stmt, 3, static_cast<int>(pad));
  sqlite3_bind_int(stmt, 4, static_cast<int>(scan_session));
  sqlite3_bind_blob(stmt, 5, encrypted_entropy.data(), static_cast<int>(encrypted_entropy.size()), SQLITE_TRANSIENT);
  if (sqlite3_step(stmt) != SQLITE_DONE) {
    error = sqlite3_errmsg(db);
    sqlite3_finalize(stmt);
    return -1;
  }
  sqlite3_finalize(stmt);

  sqlite3_stmt* sel = nullptr;
  const char* sel_sql = "SELECT id FROM seeds WHERE run_id=? AND seed_fingerprint=?";
  if (sqlite3_prepare_v2(db, sel_sql, -1, &sel, nullptr) != SQLITE_OK) {
    error = sqlite3_errmsg(db);
    return -1;
  }
  sqlite3_bind_int64(sel, 1, run_id);
  sqlite3_bind_text(sel, 2, fingerprint.c_str(), -1, SQLITE_TRANSIENT);
  int64_t seed_id = -1;
  if (sqlite3_step(sel) == SQLITE_ROW) {
    seed_id = sqlite3_column_int64(sel, 0);
  }
  sqlite3_finalize(sel);
  return seed_id;
}

bool MatchDb::insert_match(int64_t seed_id, const std::string& victim_address, const std::string& derived_address,
                           const DerivationPath& path, std::string& error) {
  auto* db = static_cast<sqlite3*>(db_);
  sqlite3_stmt* stmt = nullptr;
  const char* sql =
      "INSERT OR IGNORE INTO matches (seed_id, victim_address, derived_address, script_type, account, branch, "
      "address_index) VALUES (?,?,?,?,?,?,?)";
  if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
    error = sqlite3_errmsg(db);
    return false;
  }
  sqlite3_bind_int64(stmt, 1, seed_id);
  sqlite3_bind_text(stmt, 2, victim_address.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 3, derived_address.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_text(stmt, 4, path.script_type.c_str(), -1, SQLITE_TRANSIENT);
  sqlite3_bind_int(stmt, 5, static_cast<int>(path.account));
  sqlite3_bind_int(stmt, 6, static_cast<int>(path.branch));
  sqlite3_bind_int(stmt, 7, static_cast<int>(path.index));
  if (sqlite3_step(stmt) != SQLITE_DONE) {
    error = sqlite3_errmsg(db);
    sqlite3_finalize(stmt);
    return false;
  }
  sqlite3_finalize(stmt);
  return sqlite3_changes(db) > 0;
}

std::optional<MatchDb::RunSummary> MatchDb::get_run(const std::string& run_id, std::string& error) {
  auto* db = static_cast<sqlite3*>(db_);
  sqlite3_stmt* stmt = nullptr;
  const char* sql = "SELECT id, run_id, config_json, pads_done, seeds_tested, hits, status FROM scan_runs WHERE run_id=?";
  if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
    error = sqlite3_errmsg(db);
    return std::nullopt;
  }
  sqlite3_bind_text(stmt, 1, run_id.c_str(), -1, SQLITE_TRANSIENT);
  if (sqlite3_step(stmt) != SQLITE_ROW) {
    sqlite3_finalize(stmt);
    return std::nullopt;
  }
  RunSummary r;
  r.id = sqlite3_column_int64(stmt, 0);
  r.run_id = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
  r.config_json = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2));
  r.pads_done = static_cast<uint64_t>(sqlite3_column_int64(stmt, 3));
  r.seeds_tested = static_cast<uint64_t>(sqlite3_column_int64(stmt, 4));
  r.hits = static_cast<uint64_t>(sqlite3_column_int64(stmt, 5));
  r.status = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 6));
  sqlite3_finalize(stmt);
  return r;
}

std::optional<MatchDb::RunSummary> MatchDb::get_latest_incomplete(std::string& error) {
  auto* db = static_cast<sqlite3*>(db_);
  sqlite3_stmt* stmt = nullptr;
  const char* sql =
      "SELECT id, run_id, config_json, pads_done, seeds_tested, hits, status FROM scan_runs WHERE status='running' "
      "ORDER BY id DESC LIMIT 1";
  if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
    error = sqlite3_errmsg(db);
    return std::nullopt;
  }
  if (sqlite3_step(stmt) != SQLITE_ROW) {
    sqlite3_finalize(stmt);
    return std::nullopt;
  }
  RunSummary r;
  r.id = sqlite3_column_int64(stmt, 0);
  r.run_id = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
  r.config_json = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2));
  r.pads_done = static_cast<uint64_t>(sqlite3_column_int64(stmt, 3));
  r.seeds_tested = static_cast<uint64_t>(sqlite3_column_int64(stmt, 4));
  r.hits = static_cast<uint64_t>(sqlite3_column_int64(stmt, 5));
  r.status = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 6));
  sqlite3_finalize(stmt);
  return r;
}

std::optional<MatchDb::RunSummary> MatchDb::get_latest_resumable(std::string& error) {
  return get_latest_main_resumable(error);
}

std::optional<MatchDb::RunSummary> MatchDb::get_latest_main_resumable(std::string& error) {
  auto* db = static_cast<sqlite3*>(db_);
  sqlite3_stmt* stmt = nullptr;
  const char* sql =
      "SELECT id, run_id, config_json, pads_done, seeds_tested, hits, status FROM scan_runs "
      "WHERE status IN ('running', 'interrupted') AND run_id NOT LIKE 'backfill-for-%' "
      "ORDER BY id DESC LIMIT 1";
  if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
    error = sqlite3_errmsg(db);
    return std::nullopt;
  }
  if (sqlite3_step(stmt) != SQLITE_ROW) {
    sqlite3_finalize(stmt);
    return std::nullopt;
  }
  RunSummary r;
  r.id = sqlite3_column_int64(stmt, 0);
  r.run_id = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
  r.config_json = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2));
  r.pads_done = static_cast<uint64_t>(sqlite3_column_int64(stmt, 3));
  r.seeds_tested = static_cast<uint64_t>(sqlite3_column_int64(stmt, 4));
  r.hits = static_cast<uint64_t>(sqlite3_column_int64(stmt, 5));
  r.status = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 6));
  sqlite3_finalize(stmt);
  return r;
}

std::optional<MatchDb::RunSummary> MatchDb::get_latest_backfill_resumable(std::string& error) {
  auto* db = static_cast<sqlite3*>(db_);
  sqlite3_stmt* stmt = nullptr;
  const char* sql =
      "SELECT id, run_id, config_json, pads_done, seeds_tested, hits, status FROM scan_runs "
      "WHERE status IN ('running', 'interrupted') AND run_id LIKE 'backfill-for-%' "
      "ORDER BY id DESC LIMIT 1";
  if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
    error = sqlite3_errmsg(db);
    return std::nullopt;
  }
  if (sqlite3_step(stmt) != SQLITE_ROW) {
    sqlite3_finalize(stmt);
    return std::nullopt;
  }
  RunSummary r;
  r.id = sqlite3_column_int64(stmt, 0);
  r.run_id = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
  r.config_json = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2));
  r.pads_done = static_cast<uint64_t>(sqlite3_column_int64(stmt, 3));
  r.seeds_tested = static_cast<uint64_t>(sqlite3_column_int64(stmt, 4));
  r.hits = static_cast<uint64_t>(sqlite3_column_int64(stmt, 5));
  r.status = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 6));
  sqlite3_finalize(stmt);
  return r;
}

std::optional<MatchDb::RunSummary> MatchDb::get_latest_run(std::string& error) {
  auto* db = static_cast<sqlite3*>(db_);
  sqlite3_stmt* stmt = nullptr;
  const char* sql =
      "SELECT id, run_id, config_json, pads_done, seeds_tested, hits, status FROM scan_runs ORDER BY id DESC LIMIT 1";
  if (sqlite3_prepare_v2(db, sql, -1, &stmt, nullptr) != SQLITE_OK) {
    error = sqlite3_errmsg(db);
    return std::nullopt;
  }
  if (sqlite3_step(stmt) != SQLITE_ROW) {
    sqlite3_finalize(stmt);
    return std::nullopt;
  }
  RunSummary r;
  r.id = sqlite3_column_int64(stmt, 0);
  r.run_id = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 1));
  r.config_json = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 2));
  r.pads_done = static_cast<uint64_t>(sqlite3_column_int64(stmt, 3));
  r.seeds_tested = static_cast<uint64_t>(sqlite3_column_int64(stmt, 4));
  r.hits = static_cast<uint64_t>(sqlite3_column_int64(stmt, 5));
  r.status = reinterpret_cast<const char*>(sqlite3_column_text(stmt, 6));
  sqlite3_finalize(stmt);
  return r;
}

}  // namespace scanner
