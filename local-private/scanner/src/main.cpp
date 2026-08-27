#include "scanner/config.hpp"
#include "scanner/match_db.hpp"
#include "scanner/orchestrator.hpp"
#include "scanner/report.hpp"
#include "scanner/verify.hpp"

#include <iostream>
#include <string>

static void usage() {
  std::cout << "scanner preflight --cointrace-db <path>\n"
            << "scanner scan --config <toml> --key-file <path> [--gpu-util N] [--fresh] [--run-id ID]\n"
            << "scanner scan --backfill [--from-run-id MAIN_RUN_ID] [--backfill-to N] [--run-id ID] ...\n"
            << "scanner benchmark [--config <toml>]\n"
            << "scanner verify [--match]\n"
            << "scanner report --summary [--run-id ID] --matches-db <path>\n";
}

int main(int argc, char** argv) {
  if (argc < 2) {
    usage();
    return 1;
  }

  const std::string cmd = argv[1];

  scanner::ScanConfig cfg;
  std::string err;
  scanner::load_scan_config("config/scan-default.toml", cfg, err);

  scanner::OrchestratorOptions opts;
  opts.config = cfg;
  opts.matches_db_path = "data/matches.db";
  opts.checkpoint_dir = "data/checkpoints";
  opts.key_file = "data/.scanner.key";

  bool report_decrypt = false;
  bool verify_match = false;

  for (int i = 2; i < argc; i++) {
    const std::string arg = argv[i];
    if (arg == "--config" && i + 1 < argc) {
      scanner::load_scan_config(argv[++i], cfg, err);
      opts.config = cfg;
    } else if (arg == "--cointrace-db" && i + 1 < argc) {
      opts.config.cointrace_db_path = argv[++i];
    } else if (arg == "--key-file" && i + 1 < argc) {
      opts.key_file = argv[++i];
    } else if (arg == "--matches-db" && i + 1 < argc) {
      opts.matches_db_path = argv[++i];
    } else if (arg == "--run-id" && i + 1 < argc) {
      opts.run_id = argv[++i];
    } else if (arg == "--from-run-id" && i + 1 < argc) {
      opts.backfill_from_run_id = argv[++i];
    } else if (arg == "--backfill-to" && i + 1 < argc) {
      opts.backfill_to = static_cast<uint64_t>(std::stoull(argv[++i]));
    } else if (arg == "--backfill") {
      opts.backfill = true;
    } else if (arg == "--gpu-util" && i + 1 < argc) {
      opts.gpu_util_override = std::stoi(argv[++i]);
    } else if (arg == "--resume") {
      opts.resume = true;
    } else if (arg == "--fresh") {
      opts.fresh = true;
    } else if (arg == "--preflight-only") {
      opts.preflight_only = true;
    } else if (arg == "--no-color") {
      opts.no_color = true;
    } else if (arg == "--no-eta") {
      opts.config.show_eta = false;
    } else if (arg == "--decrypt") {
      report_decrypt = true;
    } else if (arg == "--match") {
      verify_match = true;
    }
  }

  if (opts.backfill && opts.fresh) {
    std::cerr << "error: --backfill cannot be used with --fresh\n";
    return 1;
  }

  scanner::Orchestrator orch;

  if (cmd == "preflight") return orch.run_preflight(opts);
  if (cmd == "scan") return orch.run_scan(opts);
  if (cmd == "benchmark") return orch.run_benchmark(opts);
  if (cmd == "verify") return scanner::run_verify(verify_match, cfg);
  if (cmd == "report") {
    scanner::MatchDb db;
    if (!db.open(opts.matches_db_path, err)) {
      std::cerr << err << "\n";
      return 1;
    }
    if (argc > 2 && std::string(argv[2]) == "--summary") {
      return scanner::run_report_summary(db, opts.matches_db_path, opts.run_id, report_decrypt, opts.key_file);
    }
    if (argc > 2 && std::string(argv[2]) == "--by-seed") {
      return scanner::run_report_by_seed(db, opts.matches_db_path, opts.run_id, report_decrypt, opts.key_file);
    }
    std::cerr << "usage: scanner report --summary|--by-seed\n";
    return 1;
  }

  usage();
  return 1;
}
