#include "scanner/gpu_engine.hpp"

#include "scanner/batch_derive.hpp"
#include "cuda/gpu_api.h"

#include <chrono>
#include <cstring>
#include <thread>

namespace scanner {

struct GpuEngine::Impl {
  void* cuda_handle = nullptr;
  int device_index = 0;
};

GpuEngine::GpuEngine() = default;

GpuEngine::~GpuEngine() {
  if (impl_ && impl_->cuda_handle) {
    cuda_engine_destroy(impl_->cuda_handle);
  }
  delete impl_;
  impl_ = nullptr;
}

bool GpuEngine::probe_device(int device_index, std::string& name_out, size_t& vram_mb_out, std::string& error) {
  char name[256] = {};
  char err[512] = {};
  size_t vram = 0;
  if (!cuda_probe_device(device_index, name, sizeof(name), &vram, err, sizeof(err))) {
    error = err;
    return false;
  }
  name_out = name;
  vram_mb_out = vram;
  return true;
}

bool GpuEngine::init(int device_index, const VictimSet& victims, const std::vector<DerivationPath>& paths,
                     std::string& error) {
  if (!impl_) impl_ = new Impl();
  if (impl_->cuda_handle) {
    cuda_engine_destroy(impl_->cuda_handle);
    impl_->cuda_handle = nullptr;
  }

  path_count_ = paths.size();
  const auto cuda_paths = build_cuda_path_descs(paths);
  const auto layout = build_path_layout(paths);

  std::vector<CudaVictimKey> cuda_victims;
  cuda_victims.reserve(victims.lookup_keys().size());
  for (const auto& vk : victims.lookup_keys()) {
    if (vk.key20.size() != 20) continue;
    CudaVictimKey ck{};
    memcpy(ck.key20, vk.key20.data(), 20);
    ck.victim_index = vk.victim_index;
    ck.family = static_cast<uint8_t>(vk.family);
    cuda_victims.push_back(ck);
  }
  if (cuda_victims.empty()) {
    error = "no GPU victim lookup keys";
    return false;
  }

  char err[512] = {};
  impl_->device_index = device_index;
  if (!cuda_engine_create(&impl_->cuda_handle, device_index, cuda_victims.data(), static_cast<int>(cuda_victims.size()),
                          cuda_paths.data(), static_cast<int>(cuda_paths.size()), layout.prefixes.data(),
                          static_cast<int>(layout.prefixes.size()), layout.leaves.data(),
                          static_cast<int>(layout.leaves.size()), err, sizeof(err))) {
    error = err;
    return false;
  }
  initialized_ = true;
  return true;
}

void GpuEngine::set_utilization_cap(int pct) {
  if (pct < 10) pct = 10;
  if (pct > 100) pct = 100;
  util_pct_ = pct;
}

bool GpuEngine::process_candidate_batch(const std::vector<SeedCandidate>& seeds, std::vector<GpuHit>& hits,
                                        std::string& error) {
  if (!initialized_ || !impl_ || !impl_->cuda_handle) {
    error = "GPU engine not initialized";
    return false;
  }
  if (path_count_ == 0) {
    error = "no derivation paths";
    return false;
  }
  const int seed_count = static_cast<int>(seeds.size());
  if (seed_count <= 0) return true;

  std::vector<uint32_t> pads(static_cast<size_t>(seed_count));
  std::vector<uint32_t> sessions(static_cast<size_t>(seed_count));
  for (int i = 0; i < seed_count; i++) {
    pads[static_cast<size_t>(i)] = seeds[static_cast<size_t>(i)].pad;
    sessions[static_cast<size_t>(i)] = seeds[static_cast<size_t>(i)].scan_session;
  }

  std::vector<uint8_t> masters(static_cast<size_t>(seed_count) * 64);
  char err[512] = {};
  if (!cuda_batch_seeds_to_masters(pads.data(), sessions.data(), seed_count, masters.data(), err, sizeof(err))) {
    error = err;
    return false;
  }
  return process_master_batch(seeds, masters, hits, error);
}

bool GpuEngine::process_master_batch(const std::vector<SeedCandidate>& seeds, const std::vector<uint8_t>& masters,
                                     std::vector<GpuHit>& hits, std::string& error) {
  if (!initialized_ || !impl_ || !impl_->cuda_handle) {
    error = "GPU engine not initialized";
    return false;
  }
  if (path_count_ == 0) {
    error = "no derivation paths";
    return false;
  }
  const int seed_count = static_cast<int>(seeds.size());
  const int work_count = seed_count * static_cast<int>(path_count_);
  if (work_count <= 0) return true;
  if (masters.size() != seeds.size() * 64) {
    error = "master buffer size mismatch";
    return false;
  }

  std::vector<CudaGpuHit> cuda_hits(4096);
  int hit_count = 0;
  double elapsed_ms = 0;
  char err[512] = {};
  if (!cuda_engine_process_masters(impl_->cuda_handle, masters.data(), seed_count, cuda_hits.data(), &hit_count,
                                   &elapsed_ms, err, sizeof(err))) {
    error = err;
    return false;
  }

  hits.clear();
  hits.reserve(static_cast<size_t>(hit_count));
  for (int i = 0; i < hit_count; i++) {
    const uint32_t work_index = cuda_hits[i].work_index;
    const uint32_t seed_index = work_index / static_cast<uint32_t>(path_count_);
    const uint32_t path_index = work_index % static_cast<uint32_t>(path_count_);
    GpuHit h;
    h.seed_index = seed_index;
    h.path_index = path_index;
    h.victim_index = cuda_hits[i].victim_index;
    memcpy(h.hash20, cuda_hits[i].hash20, 20);
    hits.push_back(h);
  }

  const double sec = std::max(elapsed_ms / 1000.0, 1e-9);
  last_checks_per_sec_ = static_cast<double>(work_count) / sec;

  if (util_pct_ < 100) {
    const double sleep_sec = (elapsed_ms / 1000.0) * (100.0 - util_pct_) / static_cast<double>(util_pct_);
    if (sleep_sec > 0) std::this_thread::sleep_for(std::chrono::duration<double>(sleep_sec));
  }
  return true;
}

bool GpuEngine::process_privkey_batch(const std::vector<SeedCandidate>& seeds, const std::vector<uint8_t>& privkeys,
                                     std::vector<GpuHit>& hits, std::string& error) {
  if (!initialized_ || !impl_ || !impl_->cuda_handle) {
    error = "GPU engine not initialized";
    return false;
  }
  if (path_count_ == 0) {
    error = "no derivation paths";
    return false;
  }
  const int work_count = static_cast<int>(seeds.size() * path_count_);
  if (work_count <= 0) return true;
  if (privkeys.size() != seeds.size() * path_count_ * 32) {
    error = "privkey buffer size mismatch";
    return false;
  }

  std::vector<uint8_t> pubkeys(static_cast<size_t>(work_count) * 33);
  char err[512] = {};
  if (!cuda_secp256k1_batch_pubkeys(privkeys.data(), pubkeys.data(), work_count, err, sizeof(err))) {
    error = err;
    return false;
  }

  std::vector<CudaGpuHit> cuda_hits(4096);
  int hit_count = 0;
  double elapsed_ms = 0;
  if (!cuda_engine_process_pubkeys(impl_->cuda_handle, pubkeys.data(), work_count, static_cast<int>(path_count_),
                                   cuda_hits.data(), &hit_count, &elapsed_ms, err, sizeof(err))) {
    error = err;
    return false;
  }

  hits.clear();
  hits.reserve(static_cast<size_t>(hit_count));
  for (int i = 0; i < hit_count; i++) {
    const uint32_t work_index = cuda_hits[i].work_index;
    const uint32_t seed_index = work_index / static_cast<uint32_t>(path_count_);
    const uint32_t path_index = work_index % static_cast<uint32_t>(path_count_);
    GpuHit h;
    h.seed_index = seed_index;
    h.path_index = path_index;
    h.victim_index = cuda_hits[i].victim_index;
    memcpy(h.hash20, cuda_hits[i].hash20, 20);
    hits.push_back(h);
  }

  const double sec = std::max(elapsed_ms / 1000.0, 1e-9);
  last_checks_per_sec_ = static_cast<double>(work_count) / sec;

  if (util_pct_ < 100) {
    const double sleep_sec = (elapsed_ms / 1000.0) * (100.0 - util_pct_) / static_cast<double>(util_pct_);
    if (sleep_sec > 0) std::this_thread::sleep_for(std::chrono::duration<double>(sleep_sec));
  }
  return true;
}

}  // namespace scanner
