#include "cuda/bip32_device.cuh"

#include "cuda/gpu_api.h"

#include "cuda/hash160_device.cuh"
#include "cuda/hmac_sha512_device.cuh"
#include "cuda/sha512_device.cuh"

#include <cuda_runtime.h>



#include <algorithm>

#include <cstdio>

#include <cstring>

#include <vector>



namespace {



constexpr int kThreads = 256;
constexpr int kMaxLutProbes = 64;
constexpr int kPrefixStateBytes = 97;  // priv32 + chain32 + pub33



struct CudaVictimLutEntry {

  uint8_t key20[20];

  uint8_t family;

  uint8_t occupied;

  uint8_t _pad;

  uint32_t victim_index;

};



__device__ uint32_t victim_hash_key(uint8_t family, const uint8_t* h20) {

  uint32_t v = 2166136261u ^ family;

  for (int i = 0; i < 20; i++) v = (v ^ h20[i]) * 16777619u;

  return v;

}



__device__ int victim_lut_find(const CudaVictimLutEntry* lut, int lut_size, uint8_t family, const uint8_t hash20[20]) {

  const int mask = lut_size - 1;

  uint32_t h = victim_hash_key(family, hash20);

  for (int probe = 0; probe < kMaxLutProbes; probe++) {

    const int slot = (int)((h + probe) & mask);

    const CudaVictimLutEntry& e = lut[slot];

    if (!e.occupied) return -1;

    if (e.family != family) continue;

    bool match = true;

    for (int i = 0; i < 20; i++) {

      if (e.key20[i] != hash20[i]) {

        match = false;

        break;

      }

    }

    if (match) return (int)e.victim_index;

  }

  return -1;

}



__global__ void fused_pipeline_kernel(const uint8_t* masters64, int seed_count, int path_count,

                                      const CudaPathDesc* paths, const CudaVictimLutEntry* lut, int lut_size,

                                      int* hit_work, int* hit_victim, uint8_t* hit_hash20, int* hit_count,

                                      int hits_cap) {

  const int idx = blockIdx.x * blockDim.x + threadIdx.x;

  const int work_count = seed_count * path_count;

  if (idx >= work_count) return;



  const int seed_idx = idx / path_count;

  const int path_idx = idx % path_count;



  uint8_t priv32[32];

  cuda_bip32::derive_path_from_master(masters64 + seed_idx * 64, paths[path_idx], priv32);



  uint8_t pub33[33];

  cuda_secp::secp256k1_pubkey_create(pub33, priv32);



  const uint8_t family = paths[path_idx].family;

  uint8_t lookup[20];

  hash160_pubkey_lookup(pub33, family, lookup);



  const int victim_idx = victim_lut_find(lut, lut_size, family, lookup);

  if (victim_idx < 0) return;



  const int slot = atomicAdd(hit_count, 1);

  if (slot < hits_cap) {

    hit_work[slot] = idx;

    hit_victim[slot] = victim_idx;

    for (int i = 0; i < 20; i++) hit_hash20[slot * 20 + i] = lookup[i];

  }

}



__global__ void prefix_derive_kernel(const uint8_t* masters64, int seed_count, int prefix_count,
                                     const CudaPrefixDesc* prefixes, uint8_t* prefix_states) {
  const int idx = blockIdx.x * blockDim.x + threadIdx.x;
  const int work_count = seed_count * prefix_count;
  if (idx >= work_count) return;

  const int seed_idx = idx / prefix_count;
  const int prefix_idx = idx % prefix_count;
  const uint8_t* master64 = masters64 + seed_idx * 64;
  uint8_t* out = prefix_states + (seed_idx * prefix_count + prefix_idx) * kPrefixStateBytes;

  uint8_t priv32[32];
  uint8_t chain32[32];
  uint8_t pub33[33];
  cuda_bip32::derive_prefix_from_master(master64, prefixes[prefix_idx], priv32, chain32, pub33);
  for (int i = 0; i < 32; i++) out[i] = priv32[i];
  for (int i = 0; i < 32; i++) out[32 + i] = chain32[i];
  for (int i = 0; i < 33; i++) out[64 + i] = pub33[i];
}



__global__ void leaf_pipeline_kernel(const uint8_t* prefix_states, int seed_count, int prefix_count, int leaf_count,
                                     const CudaLeafDesc* leaves, const CudaVictimLutEntry* lut, int lut_size,
                                     int* hit_work, int* hit_victim, uint8_t* hit_hash20, int* hit_count,
                                     int hits_cap) {
  const int idx = blockIdx.x * blockDim.x + threadIdx.x;
  const int work_count = seed_count * leaf_count;
  if (idx >= work_count) return;

  const int seed_idx = idx / leaf_count;
  const int leaf_idx = idx % leaf_count;
  const CudaLeafDesc& leaf = leaves[leaf_idx];
  const uint8_t* prefix = prefix_states + (seed_idx * prefix_count + leaf.prefix_id) * kPrefixStateBytes;

  uint8_t priv32[32];
  cuda_bip32::derive_leaf_from_prefix(prefix, prefix + 32, prefix + 64, leaf.step4_index, priv32);

  uint8_t pub33[33];
  cuda_secp::secp256k1_pubkey_create(pub33, priv32);

  uint8_t lookup[20];
  hash160_pubkey_lookup(pub33, leaf.family, lookup);

  const int victim_idx = victim_lut_find(lut, lut_size, leaf.family, lookup);
  if (victim_idx < 0) return;

  const int work_index = seed_idx * leaf_count + leaf.path_index;
  const int slot = atomicAdd(hit_count, 1);
  if (slot < hits_cap) {
    hit_work[slot] = work_index;
    hit_victim[slot] = victim_idx;
    for (int i = 0; i < 20; i++) hit_hash20[slot * 20 + i] = lookup[i];
  }
}



__global__ void leaf_privkey_kernel(const uint8_t* prefix_states, int seed_count, int prefix_count,
                                    const CudaLeafDesc* leaves, int leaf_count, uint8_t* privkeys32) {
  const int idx = blockIdx.x * blockDim.x + threadIdx.x;
  const int work_count = seed_count * leaf_count;
  if (idx >= work_count) return;

  const int seed_idx = idx / leaf_count;
  const int leaf_idx = idx % leaf_count;
  const CudaLeafDesc& leaf = leaves[leaf_idx];
  const uint8_t* prefix = prefix_states + (seed_idx * prefix_count + leaf.prefix_id) * kPrefixStateBytes;

  uint8_t priv32[32];
  cuda_bip32::derive_leaf_from_prefix(prefix, prefix + 32, prefix + 64, leaf.step4_index, priv32);
  uint8_t* out = privkeys32 + (seed_idx * leaf_count + leaf.path_index) * 32;
  for (int i = 0; i < 32; i++) out[i] = priv32[i];
}



__global__ void leaf_pubkey_kernel(const uint8_t* prefix_states, int seed_count, int prefix_count,
                                 const CudaLeafDesc* leaves, int leaf_count, uint8_t* pubkeys33) {
  const int idx = blockIdx.x * blockDim.x + threadIdx.x;
  const int work_count = seed_count * leaf_count;
  if (idx >= work_count) return;

  const int seed_idx = idx / leaf_count;
  const int leaf_idx = idx % leaf_count;
  const CudaLeafDesc& leaf = leaves[leaf_idx];
  const uint8_t* prefix = prefix_states + (seed_idx * prefix_count + leaf.prefix_id) * kPrefixStateBytes;

  uint8_t priv32[32];
  cuda_bip32::derive_leaf_from_prefix(prefix, prefix + 32, prefix + 64, leaf.step4_index, priv32);
  uint8_t* out = pubkeys33 + (seed_idx * leaf_count + leaf.path_index) * 33;
  cuda_secp::secp256k1_pubkey_create(out, priv32);
}



__global__ void hash_lookup_kernel(const uint8_t* pubkeys, const uint8_t* path_families, int path_count,

                                   const CudaVictimLutEntry* lut, int lut_size, int work_count, uint8_t* hash20_out,

                                   int* hit_work, int* hit_victim, int* hit_count, int hits_cap) {

  int idx = blockIdx.x * blockDim.x + threadIdx.x;

  if (idx >= work_count) return;

  const uint8_t* pub = pubkeys + idx * 33;

  int path_idx = idx % path_count;

  uint8_t family = path_families[path_idx];

  uint8_t lookup[20];

  hash160_pubkey_lookup(pub, family, lookup);

  for (int i = 0; i < 20; i++) hash20_out[idx * 20 + i] = lookup[i];



  const int victim_idx = victim_lut_find(lut, lut_size, family, lookup);

  if (victim_idx < 0) return;

  int slot = atomicAdd(hit_count, 1);

  if (slot < hits_cap) {

    hit_work[slot] = idx;

    hit_victim[slot] = victim_idx;

  }

}



void set_cuda_err(char* err, int err_cap, const char* context) {

  const cudaError_t code = cudaGetLastError();

  const char* msg = cudaGetErrorString(code);

  snprintf(err, err_cap, "%s: %s", context, msg ? msg : "unknown");

}



int next_pow2(int v) {

  int p = 1;

  while (p < v) p <<= 1;

  return p;

}



uint32_t host_victim_hash(uint8_t family, const uint8_t* h20) {

  uint32_t v = 2166136261u ^ family;

  for (int i = 0; i < 20; i++) v = (v ^ h20[i]) * 16777619u;

  return v;

}



bool build_victim_lut(const CudaVictimKey* victims, int victim_count, std::vector<CudaVictimLutEntry>& lut,

                      int& lut_size) {

  lut_size = std::max(256, next_pow2(victim_count * 2));

  lut.assign(lut_size, {});

  for (int vi = 0; vi < victim_count; vi++) {

    const auto& v = victims[vi];

    uint32_t h = host_victim_hash(v.family, v.key20);

    bool placed = false;

    for (int probe = 0; probe < kMaxLutProbes; probe++) {

      const int slot = (int)((h + probe) & (lut_size - 1));

      if (!lut[slot].occupied) {

        lut[slot].occupied = 1;

        lut[slot].family = v.family;

        lut[slot].victim_index = v.victim_index;

        memcpy(lut[slot].key20, v.key20, 20);

        placed = true;

        break;

      }

    }

    if (!placed) return false;

  }

  return true;

}



__global__ void derive_privkeys_from_masters_kernel(const uint8_t* masters64, int seed_count, int path_count,
                                                    const CudaPathDesc* paths, int num_steps, uint8_t* privkeys32) {
  const int idx = blockIdx.x * blockDim.x + threadIdx.x;
  const int work_count = seed_count * path_count;
  if (idx >= work_count) return;
  const int seed_idx = idx / path_count;
  if (num_steps >= 5) {
    cuda_bip32::derive_path_from_master(masters64 + seed_idx * 64, paths[idx % path_count], privkeys32 + idx * 32);
  } else if (num_steps <= 0) {
    for (int i = 0; i < 32; i++) privkeys32[idx * 32 + i] = masters64[seed_idx * 64 + i];
  } else {
    cuda_bip32::derive_path_from_master_steps(masters64 + seed_idx * 64, paths[idx % path_count], num_steps,
                                              privkeys32 + idx * 32);
  }
}

__global__ void derive_pubkeys_from_masters_kernel(const uint8_t* masters64, int seed_count, int path_count,
                                                   const CudaPathDesc* paths, uint8_t* pubkeys33) {
  const int idx = blockIdx.x * blockDim.x + threadIdx.x;
  const int work_count = seed_count * path_count;
  if (idx >= work_count) return;
  const int seed_idx = idx / path_count;
  uint8_t priv32[32];
  cuda_bip32::derive_path_from_master(masters64 + seed_idx * 64, paths[idx % path_count], priv32);
  cuda_secp::secp256k1_pubkey_create(pubkeys33 + idx * 33, priv32);
}



struct EngineState {

  int device = 0;

  int path_count = 0;

  int prefix_count = 0;

  int leaf_count = 0;

  std::vector<CudaPathDesc> paths;

  std::vector<CudaPrefixDesc> prefixes;

  std::vector<CudaLeafDesc> leaves;

  std::vector<uint8_t> path_families;

  std::vector<CudaVictimLutEntry> victim_lut;

  int lut_size = 0;

  CudaPathDesc* d_paths = nullptr;

  CudaPrefixDesc* d_prefixes = nullptr;

  CudaLeafDesc* d_leaves = nullptr;

  CudaVictimLutEntry* d_lut = nullptr;

  uint8_t* d_masters = nullptr;

  uint8_t* d_prefix_states = nullptr;

  uint8_t* d_pub = nullptr;

  uint8_t* d_hash = nullptr;

  uint8_t* d_path_families = nullptr;

  int* d_hit_work = nullptr;

  int* d_hit_victim = nullptr;

  uint8_t* d_hit_hash20 = nullptr;

  int* d_hit_count = nullptr;

  size_t cap_seeds = 0;

  size_t cap_work = 0;

  int hits_cap = 4096;

};



}  // namespace



extern "C" int cuda_probe_device(int device_index, char* name_out, int name_cap, size_t* vram_mb_out, char* err,

                                 int err_cap) {

  cudaDeviceProp prop{};

  if (cudaGetDeviceProperties(&prop, device_index) != cudaSuccess) {

    set_cuda_err(err, err_cap, "cudaGetDeviceProperties failed");

    return 0;

  }

  snprintf(name_out, name_cap, "%s", prop.name);

  *vram_mb_out = prop.totalGlobalMem / (1024 * 1024);

  return 1;

}



extern "C" int cuda_engine_create(void** handle_out, int device_index, const CudaVictimKey* victims, int victim_count,

                                  const CudaPathDesc* paths, int path_count, const CudaPrefixDesc* prefixes,
                                  int prefix_count, const CudaLeafDesc* leaves, int leaf_count, char* err,
                                  int err_cap) {

  if (cudaSetDevice(device_index) != cudaSuccess) {

    set_cuda_err(err, err_cap, "cudaSetDevice failed");

    return 0;

  }

  auto* st = new EngineState();

  st->device = device_index;

  st->path_count = path_count;

  st->prefix_count = prefix_count;

  st->leaf_count = leaf_count;

  st->paths.assign(paths, paths + path_count);

  if (prefixes && prefix_count > 0) st->prefixes.assign(prefixes, prefixes + prefix_count);

  if (leaves && leaf_count > 0) st->leaves.assign(leaves, leaves + leaf_count);

  st->path_families.reserve(path_count);

  for (int i = 0; i < path_count; i++) st->path_families.push_back(paths[i].family);



  if (!build_victim_lut(victims, victim_count, st->victim_lut, st->lut_size)) {

    snprintf(err, err_cap, "failed to build victim LUT");

    delete st;

    return 0;

  }



  if (cudaMalloc(&st->d_lut, st->lut_size * sizeof(CudaVictimLutEntry)) != cudaSuccess ||

      cudaMalloc(&st->d_paths, path_count * sizeof(CudaPathDesc)) != cudaSuccess ||

      cudaMalloc(&st->d_prefixes, std::max(1, prefix_count) * sizeof(CudaPrefixDesc)) != cudaSuccess ||

      cudaMalloc(&st->d_leaves, std::max(1, leaf_count) * sizeof(CudaLeafDesc)) != cudaSuccess) {

    set_cuda_err(err, err_cap, "cudaMalloc engine tables failed");

    cudaFree(st->d_lut);

    cudaFree(st->d_paths);

    cudaFree(st->d_prefixes);

    cudaFree(st->d_leaves);

    delete st;

    return 0;

  }

  if (cudaMemcpy(st->d_lut, st->victim_lut.data(), st->lut_size * sizeof(CudaVictimLutEntry), cudaMemcpyHostToDevice) !=

          cudaSuccess ||

      cudaMemcpy(st->d_paths, st->paths.data(), path_count * sizeof(CudaPathDesc), cudaMemcpyHostToDevice) !=

          cudaSuccess) {

    set_cuda_err(err, err_cap, "cudaMemcpy engine tables failed");

    cudaFree(st->d_lut);

    cudaFree(st->d_paths);

    cudaFree(st->d_prefixes);

    cudaFree(st->d_leaves);

    delete st;

    return 0;

  }

  if (prefix_count > 0 && cudaMemcpy(st->d_prefixes, st->prefixes.data(), prefix_count * sizeof(CudaPrefixDesc),
                                     cudaMemcpyHostToDevice) != cudaSuccess) {

    set_cuda_err(err, err_cap, "cudaMemcpy prefixes failed");

    cudaFree(st->d_lut);

    cudaFree(st->d_paths);

    cudaFree(st->d_prefixes);

    cudaFree(st->d_leaves);

    delete st;

    return 0;

  }

  if (leaf_count > 0 && cudaMemcpy(st->d_leaves, st->leaves.data(), leaf_count * sizeof(CudaLeafDesc),
                                     cudaMemcpyHostToDevice) != cudaSuccess) {

    set_cuda_err(err, err_cap, "cudaMemcpy leaves failed");

    cudaFree(st->d_lut);

    cudaFree(st->d_paths);

    cudaFree(st->d_prefixes);

    cudaFree(st->d_leaves);

    delete st;

    return 0;

  }

  if (cudaMalloc(&st->d_hit_count, sizeof(int)) != cudaSuccess ||

      cudaMalloc(&st->d_hit_work, st->hits_cap * sizeof(int)) != cudaSuccess ||

      cudaMalloc(&st->d_hit_victim, st->hits_cap * sizeof(int)) != cudaSuccess ||

      cudaMalloc(&st->d_hit_hash20, st->hits_cap * 20) != cudaSuccess) {

    set_cuda_err(err, err_cap, "cudaMalloc hit buffers failed");

    cudaFree(st->d_lut);

    cudaFree(st->d_paths);

    cudaFree(st->d_hit_count);

    cudaFree(st->d_hit_work);

    cudaFree(st->d_hit_victim);

    cudaFree(st->d_hit_hash20);

    delete st;

    return 0;

  }

  *handle_out = st;

  return 1;

}



extern "C" void cuda_engine_destroy(void* handle) {

  auto* st = static_cast<EngineState*>(handle);

  if (!st) return;

  cudaFree(st->d_masters);

  cudaFree(st->d_prefix_states);

  cudaFree(st->d_pub);

  cudaFree(st->d_hash);

  cudaFree(st->d_lut);

  cudaFree(st->d_paths);

  cudaFree(st->d_prefixes);

  cudaFree(st->d_leaves);

  cudaFree(st->d_path_families);

  cudaFree(st->d_hit_work);

  cudaFree(st->d_hit_victim);

  cudaFree(st->d_hit_hash20);

  cudaFree(st->d_hit_count);

  delete st;

}



static int run_hits_d2h(EngineState* st, CudaGpuHit* hits_out, int* hit_count_out, int hits_cap) {

  int hit_count = 0;

  if (cudaMemcpy(&hit_count, st->d_hit_count, sizeof(int), cudaMemcpyDeviceToHost) != cudaSuccess) return 0;

  if (hit_count > hits_cap) hit_count = hits_cap;

  *hit_count_out = hit_count;

  if (hit_count > 0) {

    std::vector<int> hw(hit_count), hv(hit_count);

    std::vector<uint8_t> hh(hit_count * 20);

    cudaMemcpy(hw.data(), st->d_hit_work, hit_count * sizeof(int), cudaMemcpyDeviceToHost);

    cudaMemcpy(hv.data(), st->d_hit_victim, hit_count * sizeof(int), cudaMemcpyDeviceToHost);

    cudaMemcpy(hh.data(), st->d_hit_hash20, hit_count * 20, cudaMemcpyDeviceToHost);

    for (int i = 0; i < hit_count; i++) {

      hits_out[i].work_index = hw[i];

      hits_out[i].victim_index = hv[i];

      memcpy(hits_out[i].hash20, hh.data() + i * 20, 20);

    }

  }

  return 1;

}



extern "C" int cuda_engine_process_masters(void* handle, const uint8_t* masters64, int seed_count,

                                           CudaGpuHit* hits_out, int* hit_count_out, double* elapsed_ms_out,

                                           char* err, int err_cap) {

  auto* st = static_cast<EngineState*>(handle);

  if (seed_count <= 0) {

    *hit_count_out = 0;

    *elapsed_ms_out = 0;

    return 1;

  }

  const int work_count = seed_count * st->path_count;



  if ((size_t)seed_count > st->cap_seeds) {

    cudaFree(st->d_masters);

    cudaFree(st->d_prefix_states);

    const size_t prefix_state_bytes =
        static_cast<size_t>(seed_count) * static_cast<size_t>(st->prefix_count) * kPrefixStateBytes;

    if (cudaMalloc(&st->d_masters, seed_count * 64) != cudaSuccess ||

        cudaMalloc(&st->d_prefix_states, std::max<size_t>(1, prefix_state_bytes)) != cudaSuccess) {

      set_cuda_err(err, err_cap, "cudaMalloc masters/prefix_states failed");

      st->d_masters = nullptr;

      st->d_prefix_states = nullptr;

      st->cap_seeds = 0;

      return 0;

    }

    st->cap_seeds = seed_count;

  }



  cudaEvent_t start, stop;

  if (cudaEventCreate(&start) != cudaSuccess || cudaEventCreate(&stop) != cudaSuccess) {

    set_cuda_err(err, err_cap, "cudaEventCreate failed");

    return 0;

  }

  cudaEventRecord(start);



  if (cudaMemcpy(st->d_masters, masters64, seed_count * 64, cudaMemcpyHostToDevice) != cudaSuccess) {

    set_cuda_err(err, err_cap, "cudaMemcpy masters failed");

    cudaEventDestroy(start);

    cudaEventDestroy(stop);

    return 0;

  }

  int zero = 0;

  if (cudaMemcpy(st->d_hit_count, &zero, sizeof(int), cudaMemcpyHostToDevice) != cudaSuccess) {

    set_cuda_err(err, err_cap, "cudaMemcpy hit_count reset failed");

    cudaEventDestroy(start);

    cudaEventDestroy(stop);

    return 0;

  }



  if (st->prefix_count <= 0 || st->leaf_count <= 0) {

    set_cuda_err(err, err_cap, "prefix/leaf layout not initialized");

    cudaEventDestroy(start);

    cudaEventDestroy(stop);

    return 0;

  }

  const int prefix_work = seed_count * st->prefix_count;

  const int leaf_work = seed_count * st->leaf_count;

  const int prefix_blocks = (prefix_work + kThreads - 1) / kThreads;

  const int leaf_blocks = (leaf_work + kThreads - 1) / kThreads;

  prefix_derive_kernel<<<prefix_blocks, kThreads>>>(st->d_masters, seed_count, st->prefix_count, st->d_prefixes,
                                                    st->d_prefix_states);

  if (cudaGetLastError() != cudaSuccess) {

    set_cuda_err(err, err_cap, "prefix_derive kernel launch failed");

    cudaEventDestroy(start);

    cudaEventDestroy(stop);

    return 0;

  }

  leaf_pipeline_kernel<<<leaf_blocks, kThreads>>>(st->d_prefix_states, seed_count, st->prefix_count, st->leaf_count,
                                                  st->d_leaves, st->d_lut, st->lut_size, st->d_hit_work,
                                                  st->d_hit_victim, st->d_hit_hash20, st->d_hit_count, st->hits_cap);

  if (cudaGetLastError() != cudaSuccess) {

    set_cuda_err(err, err_cap, "leaf_pipeline kernel launch failed");

    cudaEventDestroy(start);

    cudaEventDestroy(stop);

    return 0;

  }

  if (cudaDeviceSynchronize() != cudaSuccess) {

    set_cuda_err(err, err_cap, "cudaDeviceSynchronize failed");

    cudaEventDestroy(start);

    cudaEventDestroy(stop);

    return 0;

  }



  cudaEventRecord(stop);

  cudaEventSynchronize(stop);

  float ms = 0;

  cudaEventElapsedTime(&ms, start, stop);

  *elapsed_ms_out = ms;



  if (!run_hits_d2h(st, hits_out, hit_count_out, st->hits_cap)) {

    set_cuda_err(err, err_cap, "cudaMemcpy hits failed");

    cudaEventDestroy(start);

    cudaEventDestroy(stop);

    return 0;

  }



  cudaEventDestroy(start);

  cudaEventDestroy(stop);

  (void)work_count;

  return 1;

}



extern "C" int cuda_engine_process_pubkeys(void* handle, const uint8_t* pubkeys33, int work_count, int path_count,

                                           CudaGpuHit* hits_out, int* hit_count_out, double* elapsed_ms_out, char* err,

                                           int err_cap) {

  auto* st = static_cast<EngineState*>(handle);

  if (work_count <= 0) return 1;



  if ((size_t)work_count > st->cap_work) {

    cudaFree(st->d_pub);

    cudaFree(st->d_hash);

    if (cudaMalloc(&st->d_pub, work_count * 33) != cudaSuccess ||

        cudaMalloc(&st->d_hash, work_count * 20) != cudaSuccess) {

      set_cuda_err(err, err_cap, "cudaMalloc work buffers failed");

      st->d_pub = nullptr;

      st->d_hash = nullptr;

      st->cap_work = 0;

      return 0;

    }

    st->cap_work = work_count;

  }

  if (!st->d_path_families && path_count > 0) {

    if (cudaMalloc(&st->d_path_families, path_count) != cudaSuccess) {

      set_cuda_err(err, err_cap, "cudaMalloc path_families failed");

      return 0;

    }

    cudaMemcpy(st->d_path_families, st->path_families.data(), path_count, cudaMemcpyHostToDevice);

  }



  cudaEvent_t start, stop;

  cudaEventCreate(&start);

  cudaEventCreate(&stop);

  cudaEventRecord(start);



  cudaMemcpy(st->d_pub, pubkeys33, work_count * 33, cudaMemcpyHostToDevice);

  int zero = 0;

  cudaMemcpy(st->d_hit_count, &zero, sizeof(int), cudaMemcpyHostToDevice);



  int blocks = (work_count + kThreads - 1) / kThreads;

  hash_lookup_kernel<<<blocks, kThreads>>>(st->d_pub, st->d_path_families, path_count, st->d_lut, st->lut_size,

                                           work_count, st->d_hash, st->d_hit_work, st->d_hit_victim, st->d_hit_count,

                                           st->hits_cap);

  cudaDeviceSynchronize();



  cudaEventRecord(stop);

  cudaEventSynchronize(stop);

  float ms = 0;

  cudaEventElapsedTime(&ms, start, stop);

  *elapsed_ms_out = ms;



  run_hits_d2h(st, hits_out, hit_count_out, st->hits_cap);



  cudaEventDestroy(start);

  cudaEventDestroy(stop);

  return 1;

}



extern "C" int cuda_derive_pubkeys_from_masters(const uint8_t* masters64, int seed_count, const CudaPathDesc* paths,
                                                int path_count, uint8_t* pubkeys33_out, char* err, int err_cap) {
  if (seed_count <= 0 || path_count <= 0) return 1;
  const int work_count = seed_count * path_count;
  uint8_t* d_masters = nullptr;
  uint8_t* d_pub = nullptr;
  CudaPathDesc* d_paths = nullptr;
  if (cudaMalloc(&d_masters, seed_count * 64) != cudaSuccess || cudaMalloc(&d_pub, work_count * 33) != cudaSuccess ||
      cudaMalloc(&d_paths, path_count * sizeof(CudaPathDesc)) != cudaSuccess) {
    set_cuda_err(err, err_cap, "cudaMalloc verify buffers failed");
    cudaFree(d_masters);
    cudaFree(d_pub);
    cudaFree(d_paths);
    return 0;
  }
  if (cudaMemcpy(d_masters, masters64, seed_count * 64, cudaMemcpyHostToDevice) != cudaSuccess ||
      cudaMemcpy(d_paths, paths, path_count * sizeof(CudaPathDesc), cudaMemcpyHostToDevice) != cudaSuccess) {
    set_cuda_err(err, err_cap, "cudaMemcpy verify buffers failed");
    cudaFree(d_masters);
    cudaFree(d_pub);
    cudaFree(d_paths);
    return 0;
  }
  const int blocks = (work_count + kThreads - 1) / kThreads;
  derive_pubkeys_from_masters_kernel<<<blocks, kThreads>>>(d_masters, seed_count, path_count, d_paths, d_pub);
  if (cudaGetLastError() != cudaSuccess || cudaDeviceSynchronize() != cudaSuccess) {
    set_cuda_err(err, err_cap, "derive_pubkeys kernel failed");
    cudaFree(d_masters);
    cudaFree(d_pub);
    cudaFree(d_paths);
    return 0;
  }
  if (cudaMemcpy(pubkeys33_out, d_pub, work_count * 33, cudaMemcpyDeviceToHost) != cudaSuccess) {
    set_cuda_err(err, err_cap, "cudaMemcpy verify pubkeys failed");
    cudaFree(d_masters);
    cudaFree(d_pub);
    cudaFree(d_paths);
    return 0;
  }
  cudaFree(d_masters);
  cudaFree(d_pub);
  cudaFree(d_paths);
  return 1;
}

extern "C" int cuda_derive_privkeys_from_masters(const uint8_t* masters64, int seed_count, const CudaPathDesc* paths,
                                                 int path_count, uint8_t* privkeys32_out, char* err, int err_cap) {
  if (seed_count <= 0 || path_count <= 0) return 1;
  const int work_count = seed_count * path_count;
  uint8_t* d_masters = nullptr;
  uint8_t* d_priv = nullptr;
  CudaPathDesc* d_paths = nullptr;
  if (cudaMalloc(&d_masters, seed_count * 64) != cudaSuccess || cudaMalloc(&d_priv, work_count * 32) != cudaSuccess ||
      cudaMalloc(&d_paths, path_count * sizeof(CudaPathDesc)) != cudaSuccess) {
    set_cuda_err(err, err_cap, "cudaMalloc privkey verify buffers failed");
    cudaFree(d_masters);
    cudaFree(d_priv);
    cudaFree(d_paths);
    return 0;
  }
  cudaMemcpy(d_masters, masters64, seed_count * 64, cudaMemcpyHostToDevice);
  cudaMemcpy(d_paths, paths, path_count * sizeof(CudaPathDesc), cudaMemcpyHostToDevice);
  const int blocks = (work_count + kThreads - 1) / kThreads;
  derive_privkeys_from_masters_kernel<<<blocks, kThreads>>>(d_masters, seed_count, path_count, d_paths, 5, d_priv);
  if (cudaGetLastError() != cudaSuccess || cudaDeviceSynchronize() != cudaSuccess) {
    set_cuda_err(err, err_cap, "derive_privkeys kernel failed");
    cudaFree(d_masters);
    cudaFree(d_priv);
    cudaFree(d_paths);
    return 0;
  }
  cudaMemcpy(privkeys32_out, d_priv, work_count * 32, cudaMemcpyDeviceToHost);
  cudaFree(d_masters);
  cudaFree(d_priv);
  cudaFree(d_paths);
  return 1;
}

extern "C" int cuda_derive_privkeys_from_masters_steps(const uint8_t* masters64, int seed_count, const CudaPathDesc* paths,
                                                       int path_count, int num_steps, uint8_t* privkeys32_out,
                                                       char* err, int err_cap) {
  if (seed_count <= 0 || path_count <= 0) return 1;
  const int work_count = seed_count * path_count;
  uint8_t* d_masters = nullptr;
  uint8_t* d_priv = nullptr;
  CudaPathDesc* d_paths = nullptr;
  if (cudaMalloc(&d_masters, seed_count * 64) != cudaSuccess || cudaMalloc(&d_priv, work_count * 32) != cudaSuccess ||
      cudaMalloc(&d_paths, path_count * sizeof(CudaPathDesc)) != cudaSuccess) {
    set_cuda_err(err, err_cap, "cudaMalloc privkey verify buffers failed");
    cudaFree(d_masters);
    cudaFree(d_priv);
    cudaFree(d_paths);
    return 0;
  }
  cudaMemcpy(d_masters, masters64, seed_count * 64, cudaMemcpyHostToDevice);
  cudaMemcpy(d_paths, paths, path_count * sizeof(CudaPathDesc), cudaMemcpyHostToDevice);
  const int blocks = (work_count + kThreads - 1) / kThreads;
  derive_privkeys_from_masters_kernel<<<blocks, kThreads>>>(d_masters, seed_count, path_count, d_paths, num_steps,
                                                            d_priv);
  if (cudaGetLastError() != cudaSuccess || cudaDeviceSynchronize() != cudaSuccess) {
    set_cuda_err(err, err_cap, "derive_privkeys kernel failed");
    cudaFree(d_masters);
    cudaFree(d_priv);
    cudaFree(d_paths);
    return 0;
  }
  cudaMemcpy(privkeys32_out, d_priv, work_count * 32, cudaMemcpyDeviceToHost);
  cudaFree(d_masters);
  cudaFree(d_priv);
  cudaFree(d_paths);
  return 1;
}

static int run_dedup_prefix_leaf(const uint8_t* masters64, int seed_count, const CudaPrefixDesc* prefixes,
                                 int prefix_count, const CudaLeafDesc* leaves, int leaf_count,
                                 uint8_t** d_prefix_states_out, uint8_t** d_masters_out, CudaLeafDesc** d_leaves_out,
                                 char* err, int err_cap) {
  uint8_t* d_masters = nullptr;
  uint8_t* d_prefix_states = nullptr;
  CudaPrefixDesc* d_prefixes = nullptr;
  CudaLeafDesc* d_leaves = nullptr;
  if (cudaMalloc(&d_masters, seed_count * 64) != cudaSuccess ||
      cudaMalloc(&d_prefix_states, std::max(1, seed_count * prefix_count * kPrefixStateBytes)) != cudaSuccess ||
      cudaMalloc(&d_prefixes, prefix_count * sizeof(CudaPrefixDesc)) != cudaSuccess ||
      cudaMalloc(&d_leaves, leaf_count * sizeof(CudaLeafDesc)) != cudaSuccess) {
    set_cuda_err(err, err_cap, "cudaMalloc dedup buffers failed");
    cudaFree(d_masters);
    cudaFree(d_prefix_states);
    cudaFree(d_prefixes);
    cudaFree(d_leaves);
    return 0;
  }
  if (cudaMemcpy(d_masters, masters64, seed_count * 64, cudaMemcpyHostToDevice) != cudaSuccess ||
      cudaMemcpy(d_prefixes, prefixes, prefix_count * sizeof(CudaPrefixDesc), cudaMemcpyHostToDevice) != cudaSuccess ||
      cudaMemcpy(d_leaves, leaves, leaf_count * sizeof(CudaLeafDesc), cudaMemcpyHostToDevice) != cudaSuccess) {
    set_cuda_err(err, err_cap, "cudaMemcpy dedup desc failed");
    cudaFree(d_masters);
    cudaFree(d_prefix_states);
    cudaFree(d_prefixes);
    cudaFree(d_leaves);
    return 0;
  }
  const int prefix_work = seed_count * prefix_count;
  prefix_derive_kernel<<<(prefix_work + kThreads - 1) / kThreads, kThreads>>>(d_masters, seed_count, prefix_count,
                                                                              d_prefixes, d_prefix_states);
  cudaFree(d_prefixes);
  if (cudaGetLastError() != cudaSuccess || cudaDeviceSynchronize() != cudaSuccess) {
    set_cuda_err(err, err_cap, "prefix_derive verify failed");
    cudaFree(d_masters);
    cudaFree(d_prefix_states);
    cudaFree(d_leaves);
    return 0;
  }
  *d_prefix_states_out = d_prefix_states;
  *d_masters_out = d_masters;
  *d_leaves_out = d_leaves;
  return 1;
}

extern "C" int cuda_derive_leaf_privkeys_dedup(const uint8_t* masters64, int seed_count, const CudaPrefixDesc* prefixes,
                                               int prefix_count, const CudaLeafDesc* leaves, int leaf_count,
                                               uint8_t* privkeys32_out, char* err, int err_cap) {
  if (seed_count <= 0 || leaf_count <= 0 || prefix_count <= 0) return 1;
  uint8_t* d_masters = nullptr;
  uint8_t* d_prefix_states = nullptr;
  CudaLeafDesc* d_leaves = nullptr;
  uint8_t* d_priv = nullptr;
  if (!run_dedup_prefix_leaf(masters64, seed_count, prefixes, prefix_count, leaves, leaf_count, &d_prefix_states,
                             &d_masters, &d_leaves, err, err_cap)) {
    return 0;
  }
  if (cudaMalloc(&d_priv, seed_count * leaf_count * 32) != cudaSuccess) {
    set_cuda_err(err, err_cap, "cudaMalloc dedup priv failed");
    cudaFree(d_masters);
    cudaFree(d_prefix_states);
    cudaFree(d_leaves);
    return 0;
  }
  const int leaf_work = seed_count * leaf_count;
  leaf_privkey_kernel<<<(leaf_work + kThreads - 1) / kThreads, kThreads>>>(d_prefix_states, seed_count, prefix_count,
                                                                           d_leaves, leaf_count, d_priv);
  if (cudaGetLastError() != cudaSuccess || cudaDeviceSynchronize() != cudaSuccess) {
    set_cuda_err(err, err_cap, "leaf_privkey kernel failed");
    cudaFree(d_masters);
    cudaFree(d_prefix_states);
    cudaFree(d_leaves);
    cudaFree(d_priv);
    return 0;
  }
  cudaMemcpy(privkeys32_out, d_priv, seed_count * leaf_count * 32, cudaMemcpyDeviceToHost);
  cudaFree(d_masters);
  cudaFree(d_prefix_states);
  cudaFree(d_leaves);
  cudaFree(d_priv);
  return 1;
}

extern "C" int cuda_derive_leaf_pubkeys_dedup(const uint8_t* masters64, int seed_count, const CudaPrefixDesc* prefixes,
                                              int prefix_count, const CudaLeafDesc* leaves, int leaf_count,
                                              uint8_t* pubkeys33_out, char* err, int err_cap) {
  if (seed_count <= 0 || leaf_count <= 0 || prefix_count <= 0) return 1;
  uint8_t* d_masters = nullptr;
  uint8_t* d_prefix_states = nullptr;
  CudaLeafDesc* d_leaves = nullptr;
  uint8_t* d_pub = nullptr;
  if (!run_dedup_prefix_leaf(masters64, seed_count, prefixes, prefix_count, leaves, leaf_count, &d_prefix_states,
                             &d_masters, &d_leaves, err, err_cap)) {
    return 0;
  }
  if (cudaMalloc(&d_pub, seed_count * leaf_count * 33) != cudaSuccess) {
    set_cuda_err(err, err_cap, "cudaMalloc dedup pub failed");
    cudaFree(d_masters);
    cudaFree(d_prefix_states);
    cudaFree(d_leaves);
    return 0;
  }
  const int leaf_work = seed_count * leaf_count;
  leaf_pubkey_kernel<<<(leaf_work + kThreads - 1) / kThreads, kThreads>>>(d_prefix_states, seed_count, prefix_count,
                                                                          d_leaves, leaf_count, d_pub);
  if (cudaGetLastError() != cudaSuccess || cudaDeviceSynchronize() != cudaSuccess) {
    set_cuda_err(err, err_cap, "leaf_pubkey kernel failed");
    cudaFree(d_masters);
    cudaFree(d_prefix_states);
    cudaFree(d_leaves);
    cudaFree(d_pub);
    return 0;
  }
  cudaMemcpy(pubkeys33_out, d_pub, seed_count * leaf_count * 33, cudaMemcpyDeviceToHost);
  cudaFree(d_masters);
  cudaFree(d_prefix_states);
  cudaFree(d_leaves);
  cudaFree(d_pub);
  return 1;
}

__global__ void crypto_selftest_kernel(uint8_t* sha_empty_out, uint8_t* hmac_out, int* field_err_out) {
  const uint8_t dummy = 0;
  sha512_bytes(&dummy, 0, sha_empty_out);

  uint8_t key[32];
  uint8_t data[37];
  for (int i = 0; i < 32; i++) key[i] = static_cast<uint8_t>(i + 1);
  data[0] = 0;
  for (int i = 0; i < 32; i++) data[1 + i] = static_cast<uint8_t>(0x40 + i);
  data[33] = 0x80;
  data[34] = 0x00;
  data[35] = 0x00;
  data[36] = 0x54;
  hmac_sha512_device(key, 32, data, 37, hmac_out);
  *field_err_out = cuda_secp::field_selftest_device();
}

extern "C" int cuda_crypto_selftest(char* err, int err_cap) {
  uint8_t* d_sha = nullptr;
  uint8_t* d_hmac = nullptr;
  int* d_field = nullptr;
  if (cudaMalloc(&d_sha, 64) != cudaSuccess || cudaMalloc(&d_hmac, 64) != cudaSuccess ||
      cudaMalloc(&d_field, sizeof(int)) != cudaSuccess) {
    set_cuda_err(err, err_cap, "cudaMalloc selftest failed");
    cudaFree(d_sha);
    cudaFree(d_hmac);
    cudaFree(d_field);
    return 0;
  }
  crypto_selftest_kernel<<<1, 1>>>(d_sha, d_hmac, d_field);
  if (cudaGetLastError() != cudaSuccess || cudaDeviceSynchronize() != cudaSuccess) {
    set_cuda_err(err, err_cap, "crypto_selftest kernel failed");
    cudaFree(d_sha);
    cudaFree(d_hmac);
    cudaFree(d_field);
    return 0;
  }
  uint8_t sha[64] = {};
  uint8_t mac[64] = {};
  int field_err = -1;
  cudaMemcpy(sha, d_sha, 64, cudaMemcpyDeviceToHost);
  cudaMemcpy(mac, d_hmac, 64, cudaMemcpyDeviceToHost);
  cudaMemcpy(&field_err, d_field, sizeof(int), cudaMemcpyDeviceToHost);
  cudaFree(d_sha);
  cudaFree(d_hmac);
  cudaFree(d_field);

  static const uint8_t kShaEmpty[64] = {
      0xcf, 0x83, 0xe1, 0x35, 0x7e, 0xef, 0xb8, 0xbd, 0xf1, 0x54, 0x28, 0x50, 0xd6, 0x6d, 0x80, 0x07,
      0xd6, 0x20, 0xe4, 0x05, 0x0b, 0x57, 0x15, 0xdc, 0x83, 0xf4, 0xa9, 0x21, 0xd3, 0x6c, 0xe9, 0xce,
      0x47, 0xd0, 0xd1, 0x3c, 0x5d, 0x85, 0xf2, 0xb0, 0xff, 0x83, 0x18, 0xd2, 0x87, 0x7e, 0xec, 0x2f,
      0x63, 0xb9, 0x31, 0xbd, 0x47, 0x41, 0x7a, 0x81, 0xa5, 0x38, 0x32, 0x7a, 0xf9, 0x27, 0xda, 0x3e};
  if (memcmp(sha, kShaEmpty, 64) != 0) {
    set_cuda_err(err, err_cap, "device SHA-512 empty mismatch");
    return 0;
  }

  static const uint8_t kHmac[64] = {
      0x51, 0xed, 0x74, 0x09, 0xac, 0x28, 0xd6, 0xe8, 0xfa, 0x08, 0x03, 0xda, 0x7a, 0xba, 0x95, 0x12,
      0x0f, 0x16, 0x1b, 0x84, 0x44, 0x69, 0x80, 0xe2, 0xf8, 0x22, 0x86, 0x5b, 0x7c, 0x8c, 0x8f, 0x79,
      0xe9, 0x3c, 0xdc, 0xee, 0x17, 0xbc, 0x7c, 0x5f, 0x5a, 0xc7, 0x9c, 0x97, 0xab, 0x98, 0x54, 0xa8,
      0x22, 0x7c, 0x76, 0x6d, 0x09, 0x4b, 0x7b, 0x85, 0x16, 0xe1, 0xd3, 0xab, 0x3f, 0x24, 0xaf, 0xc5};
  if (memcmp(mac, kHmac, 64) != 0) {
    set_cuda_err(err, err_cap, "device HMAC-SHA512 mismatch");
    return 0;
  }
  if (field_err != 0) {
    char msg[64];
    snprintf(msg, sizeof(msg), "device field selftest failed code %d", field_err);
    set_cuda_err(err, err_cap, msg);
    return 0;
  }
  return 1;
}

__global__ void hmac_kernel(const uint8_t* key, int key_len, const uint8_t* data, int data_len, uint8_t* out64) {
  hmac_sha512_device(key, key_len, data, data_len, out64);
}

extern "C" int cuda_hmac_sha512(const uint8_t* key, int key_len, const uint8_t* data, int data_len, uint8_t* out64,
                                char* err, int err_cap) {
  uint8_t *d_key = nullptr, *d_data = nullptr, *d_out = nullptr;
  if (cudaMalloc(&d_key, key_len) != cudaSuccess || cudaMalloc(&d_data, data_len) != cudaSuccess ||
      cudaMalloc(&d_out, 64) != cudaSuccess) {
    set_cuda_err(err, err_cap, "cudaMalloc hmac failed");
    cudaFree(d_key);
    cudaFree(d_data);
    cudaFree(d_out);
    return 0;
  }
  cudaMemcpy(d_key, key, key_len, cudaMemcpyHostToDevice);
  cudaMemcpy(d_data, data, data_len, cudaMemcpyHostToDevice);
  hmac_kernel<<<1, 1>>>(d_key, key_len, d_data, data_len, d_out);
  if (cudaGetLastError() != cudaSuccess || cudaDeviceSynchronize() != cudaSuccess) {
    set_cuda_err(err, err_cap, "hmac kernel failed");
    cudaFree(d_key);
    cudaFree(d_data);
    cudaFree(d_out);
    return 0;
  }
  cudaMemcpy(out64, d_out, 64, cudaMemcpyDeviceToHost);
  cudaFree(d_key);
  cudaFree(d_data);
  cudaFree(d_out);
  return 1;
}
