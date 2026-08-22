#pragma once

#include <string>

namespace scanner {

class MatchDb;

int run_report_summary(MatchDb& db, const std::string& matches_db_path, const std::string& run_id, bool decrypt,
                       const std::string& key_file);
int run_report_by_seed(MatchDb& db, const std::string& matches_db_path, const std::string& run_id, bool decrypt,
                       const std::string& key_file);

}  // namespace scanner
