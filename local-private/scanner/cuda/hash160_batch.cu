#include "cuda/gpu_api.h"
#include "cuda/hash160_device.cuh"

#include <cuda_runtime.h>

#include <cstdio>
#include <cstring>

namespace {

constexpr int kThreads = 256;

void set_cuda_err(char* err, int err_cap, const char* context) {
  const cudaError_t code = cudaGetLastError();
  const char* msg = cudaGetErrorString(code);
  snprintf(err, err_cap, "%s: %s", context, msg ? msg : "unknown");
}

__global__ void hash160_only_kernel(const uint8_t* pubkeys, const uint8_t* path_families, int path_count, int work_count,
                                    uint8_t* hash20_out) {
  int idx = blockIdx.x * blockDim.x + threadIdx.x;
  if (idx >= work_count) return;
  const uint8_t* pub = pubkeys + idx * 33;
  int path_idx = idx % path_count;
  uint8_t family = path_families[path_idx];
  hash160_pubkey_lookup(pub, family, hash20_out + idx * 20);
}

}  // namespace

extern "C" int cuda_hash160_batch(const uint8_t* pubkeys33, const uint8_t* path_families, int work_count, int path_count,
                                  uint8_t* hash20_out, char* err, int err_cap) {
  if (work_count <= 0) return 1;
  if (cudaSetDevice(0) != cudaSuccess) {
    set_cuda_err(err, err_cap, "cudaSetDevice failed");
    return 0;
  }
  uint8_t* d_pub = nullptr;
  uint8_t* d_families = nullptr;
  uint8_t* d_hash = nullptr;
  if (cudaMalloc(&d_pub, work_count * 33) != cudaSuccess ||
      cudaMalloc(&d_families, path_count) != cudaSuccess ||
      cudaMalloc(&d_hash, work_count * 20) != cudaSuccess) {
    set_cuda_err(err, err_cap, "cudaMalloc failed");
    cudaFree(d_pub);
    cudaFree(d_families);
    cudaFree(d_hash);
    return 0;
  }
  if (cudaMemcpy(d_pub, pubkeys33, work_count * 33, cudaMemcpyHostToDevice) != cudaSuccess) {
    set_cuda_err(err, err_cap, "cudaMemcpy pubkeys failed");
    cudaFree(d_pub);
    cudaFree(d_families);
    cudaFree(d_hash);
    return 0;
  }
  if (cudaMemcpy(d_families, path_families, path_count, cudaMemcpyHostToDevice) != cudaSuccess) {
    set_cuda_err(err, err_cap, "cudaMemcpy families failed");
    cudaFree(d_pub);
    cudaFree(d_families);
    cudaFree(d_hash);
    return 0;
  }
  int blocks = (work_count + kThreads - 1) / kThreads;
  hash160_only_kernel<<<blocks, kThreads>>>(d_pub, d_families, path_count, work_count, d_hash);
  if (cudaGetLastError() != cudaSuccess) {
    set_cuda_err(err, err_cap, "hash160 kernel launch failed");
    cudaFree(d_pub);
    cudaFree(d_families);
    cudaFree(d_hash);
    return 0;
  }
  if (cudaDeviceSynchronize() != cudaSuccess) {
    set_cuda_err(err, err_cap, "cudaDeviceSynchronize failed");
    cudaFree(d_pub);
    cudaFree(d_families);
    cudaFree(d_hash);
    return 0;
  }
  if (cudaMemcpy(hash20_out, d_hash, work_count * 20, cudaMemcpyDeviceToHost) != cudaSuccess) {
    set_cuda_err(err, err_cap, "cudaMemcpy hash results failed");
    cudaFree(d_pub);
    cudaFree(d_families);
    cudaFree(d_hash);
    return 0;
  }
  cudaFree(d_pub);
  cudaFree(d_families);
  cudaFree(d_hash);
  return 1;
}
