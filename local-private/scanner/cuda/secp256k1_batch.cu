#include "cuda/field.cuh"
#include "cuda/gpu_api.h"

#include <cuda_runtime.h>
#include <cstdio>
#include <cstring>

namespace {

constexpr int kThreads = 256;

__global__ void secp_batch_kernel(const uint8_t* privkeys, uint8_t* pubkeys33, int count) {
  const int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= count) return;
  cuda_secp::secp256k1_pubkey_create(pubkeys33 + i * 33, privkeys + i * 32);
}

}  // namespace

extern "C" int cuda_secp256k1_batch_pubkeys(const uint8_t* privkeys, uint8_t* pubkeys33, int count, char* err,
                                            int err_cap) {
  if (count <= 0) return 1;
  if (!privkeys || !pubkeys33) {
    snprintf(err, err_cap, "null buffer");
    return 0;
  }

  uint8_t* d_priv = nullptr;
  uint8_t* d_pub = nullptr;
  if (cudaMalloc(&d_priv, count * 32) != cudaSuccess || cudaMalloc(&d_pub, count * 33) != cudaSuccess) {
    snprintf(err, err_cap, "cudaMalloc secp batch failed");
    cudaFree(d_priv);
    cudaFree(d_pub);
    return 0;
  }

  if (cudaMemcpy(d_priv, privkeys, count * 32, cudaMemcpyHostToDevice) != cudaSuccess) {
    snprintf(err, err_cap, "cudaMemcpy H2D secp privkeys failed");
    cudaFree(d_priv);
    cudaFree(d_pub);
    return 0;
  }

  const int blocks = (count + kThreads - 1) / kThreads;
  secp_batch_kernel<<<blocks, kThreads>>>(d_priv, d_pub, count);
  if (cudaGetLastError() != cudaSuccess || cudaDeviceSynchronize() != cudaSuccess) {
    snprintf(err, err_cap, "secp_batch_kernel failed");
    cudaFree(d_priv);
    cudaFree(d_pub);
    return 0;
  }

  if (cudaMemcpy(pubkeys33, d_pub, count * 33, cudaMemcpyDeviceToHost) != cudaSuccess) {
    snprintf(err, err_cap, "cudaMemcpy D2H secp pubkeys failed");
    cudaFree(d_priv);
    cudaFree(d_pub);
    return 0;
  }

  cudaFree(d_priv);
  cudaFree(d_pub);
  return 1;
}
