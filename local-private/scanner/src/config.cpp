#include "scanner/config.hpp"

#include <fstream>
#include <sstream>

namespace scanner {

static std::string trim(const std::string& s) {
  size_t start = 0;
  while (start < s.size() && (s[start] == ' ' || s[start] == '\t' || s[start] == '\r')) start++;
  size_t end = s.size();
  while (end > start && (s[end - 1] == ' ' || s[end - 1] == '\t' || s[end - 1] == '\r')) end--;
  return s.substr(start, end - start);
}

static bool parse_u32(const std::string& v, uint32_t& out) {
  try {
    out = static_cast<uint32_t>(std::stoul(v));
    return true;
  } catch (...) {
    return false;
  }
}

static bool parse_int(const std::string& v, int& out) {
  try {
    out = std::stoi(v);
    return true;
  } catch (...) {
    return false;
  }
}

static bool parse_bool(const std::string& v, bool& out) {
  if (v == "true" || v == "1") {
    out = true;
    return true;
  }
  if (v == "false" || v == "0") {
    out = false;
    return true;
  }
  return false;
}

static bool parse_double(const std::string& v, double& out) {
  try {
    out = std::stod(v);
    return true;
  } catch (...) {
    return false;
  }
}

bool load_scan_config(const std::string& path, ScanConfig& cfg, std::string& error) {
  std::ifstream in(path);
  if (!in) {
    error = "cannot open config: " + path;
    return false;
  }
  std::string section;
  std::string line;
  while (std::getline(in, line)) {
  line = trim(line);
    if (line.empty() || line[0] == '#') continue;
    if (line.front() == '[' && line.back() == ']') {
      section = line.substr(1, line.size() - 2);
      continue;
    }
    const size_t eq = line.find('=');
    if (eq == std::string::npos) continue;
    const std::string key = trim(line.substr(0, eq));
    const std::string val = trim(line.substr(eq + 1));
    uint32_t u32 = 0;
    int i = 0;
    bool b = false;
    double d = 0;

    if (section == "scan") {
      if (key == "pad_high_min" && parse_u32(val, u32)) cfg.pad_high_min = u32;
      else if (key == "pad_high_max" && parse_u32(val, u32)) cfg.pad_high_max = u32;
      else if (key == "pad_high_filter_min" && parse_u32(val, u32)) cfg.pad_high_filter_min = u32;
      else if (key == "pad_high_filter_max" && parse_u32(val, u32)) cfg.pad_high_filter_max = u32;
      else if (key == "scan_session_min" && parse_u32(val, u32)) cfg.scan_session_min = u32;
      else if (key == "scan_session_max" && parse_u32(val, u32)) cfg.scan_session_max = u32;
    } else if (section == "bip84") {
      if (key == "accounts_min" && parse_u32(val, u32)) cfg.bip84_accounts_min = u32;
      else if (key == "accounts_max" && parse_u32(val, u32)) cfg.bip84_accounts_max = u32;
      else if (key == "receive_min" && parse_u32(val, u32)) cfg.bip84_receive_min = u32;
      else if (key == "receive_max" && parse_u32(val, u32)) cfg.bip84_receive_max = u32;
      else if (key == "change_min" && parse_u32(val, u32)) cfg.bip84_change_min = u32;
      else if (key == "change_max" && parse_u32(val, u32)) cfg.bip84_change_max = u32;
    } else if (section == "bip49") {
      if (key == "receive_min" && parse_u32(val, u32)) cfg.bip49_receive_min = u32;
      else if (key == "receive_max" && parse_u32(val, u32)) cfg.bip49_receive_max = u32;
    } else if (section == "bip44") {
      if (key == "receive_min" && parse_u32(val, u32)) cfg.bip44_receive_min = u32;
      else if (key == "receive_max" && parse_u32(val, u32)) cfg.bip44_receive_max = u32;
    } else if (section == "gpu") {
      if (key == "device_index" && parse_int(val, i)) cfg.gpu_device_index = i;
      else if (key == "gpu_util_pct" && parse_int(val, i)) cfg.gpu_util_pct = i;
      else if (key == "base_batch_seeds" && parse_int(val, i)) cfg.base_batch_seeds = i;
      else if (key == "max_cuda_streams" && parse_int(val, i)) cfg.max_cuda_streams = i;
    } else if (section == "logging") {
      if (key == "progress_interval_sec" && parse_int(val, i)) cfg.progress_interval_sec = i;
      else if (key == "show_live_matches" && parse_bool(val, b)) cfg.show_live_matches = b;
      else if (key == "abbrev_len" && parse_int(val, i)) cfg.abbrev_len = i;
      else if (key == "color_enabled" && parse_bool(val, b)) cfg.color_enabled = b;
      else if (key == "eta_smoothing_alpha" && parse_double(val, d)) cfg.eta_smoothing_alpha = d;
    } else if (section == "cointrace") {
      if (key == "db_path") cfg.cointrace_db_path = val;
      else if (key == "db_max_age_hours" && parse_int(val, i)) cfg.cointrace_db_max_age_hours = i;
    }
  }
  return true;
}

}  // namespace scanner
