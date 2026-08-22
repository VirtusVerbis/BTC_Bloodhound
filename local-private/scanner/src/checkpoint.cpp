#include "scanner/checkpoint.hpp"

#include <fstream>
#include <sstream>

namespace scanner {

std::string checkpoint_path(const std::string& dir, const std::string& run_id) {
  return dir + "/" + run_id + ".json";
}

static std::string escape_json(const std::string& s) {
  std::string out;
  for (char c : s) {
    if (c == '"' || c == '\\') out += '\\';
    out += c;
  }
  return out;
}

bool save_checkpoint(const std::string& dir, const CheckpointState& state, std::string& error) {
  const std::string path = checkpoint_path(dir, state.run_id);
  std::ofstream out(path, std::ios::trunc);
  if (!out) {
    error = "cannot write checkpoint: " + path;
    return false;
  }
  out << "{\n"
      << "  \"run_id\": \"" << escape_json(state.run_id) << "\",\n"
      << "  \"config_hash\": \"" << escape_json(state.config_hash) << "\",\n"
      << "  \"next_pad_index\": " << state.next_pad_index << ",\n"
      << "  \"pads_total\": " << state.pads_total << ",\n"
      << "  \"seeds_tested\": " << state.seeds_tested << ",\n"
      << "  \"hits\": " << state.hits << ",\n"
      << "  \"elapsed_sec\": " << state.elapsed_sec << ",\n"
      << "  \"victim_snapshot_hash\": \"" << escape_json(state.victim_snapshot_hash) << "\",\n"
      << "  \"gpu_util_pct\": " << state.gpu_util_pct << "\n"
      << "}\n";
  return true;
}

bool load_checkpoint(const std::string& dir, const std::string& run_id, CheckpointState& state, std::string& error) {
  const std::string path = checkpoint_path(dir, run_id);
  std::ifstream in(path);
  if (!in) {
    error = "checkpoint not found: " + path;
    return false;
  }
  std::string content((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  auto find_num = [&](const std::string& key, uint64_t& out) {
    const std::string needle = "\"" + key + "\": ";
    const size_t p = content.find(needle);
    if (p == std::string::npos) return false;
    out = std::stoull(content.substr(p + needle.size()));
    return true;
  };
  auto find_dbl = [&](const std::string& key, double& out) {
    const std::string needle = "\"" + key + "\": ";
    const size_t p = content.find(needle);
    if (p == std::string::npos) return false;
    out = std::stod(content.substr(p + needle.size()));
    return true;
  };
  auto find_str = [&](const std::string& key, std::string& out) {
    const std::string needle = "\"" + key + "\": \"";
    const size_t p = content.find(needle);
    if (p == std::string::npos) return false;
    const size_t start = p + needle.size();
    const size_t end = content.find('"', start);
    out = content.substr(start, end - start);
    return true;
  };
  state.run_id = run_id;
  if (!find_str("config_hash", state.config_hash)) {
    error = "invalid checkpoint json";
    return false;
  }
  find_num("next_pad_index", state.next_pad_index);
  find_num("pads_total", state.pads_total);
  find_num("seeds_tested", state.seeds_tested);
  find_num("hits", state.hits);
  find_dbl("elapsed_sec", state.elapsed_sec);
  find_str("victim_snapshot_hash", state.victim_snapshot_hash);
  uint64_t gpu = state.gpu_util_pct;
  find_num("gpu_util_pct", gpu);
  state.gpu_util_pct = static_cast<int>(gpu);
  return true;
}

}  // namespace scanner
