#include "cuda/gpu_api.h"

#include "cuda/hash160_device.cuh"
#include "cuda/hmac_sha512_device.cuh"
#include "cuda/yasmarang_device.cuh"

#include <cuda_runtime.h>

#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

namespace {

constexpr int kWordCount = 2048;
constexpr int kWordMaxLen = 9;
constexpr int kThreads = 256;

char* g_bip39_words_dev = nullptr;
int* g_bip39_lens_dev = nullptr;

__device__ void sha256d_device(const uint8_t* data, int len, uint8_t out32[32]) {
  uint8_t h1[32];
  hash160_sha256_bytes(data, len, h1);
  hash160_sha256_bytes(h1, 32, out32);
}

__device__ void pbkdf2_hmac_sha512_device(const uint8_t* password, int pass_len, const uint8_t* salt, int salt_len,
                                          int iterations, uint8_t out64[64]) {
  uint8_t salt_block[256];
  for (int i = 0; i < salt_len; i++) salt_block[i] = salt[i];
  salt_block[salt_len] = 0;
  salt_block[salt_len + 1] = 0;
  salt_block[salt_len + 2] = 0;
  salt_block[salt_len + 3] = 1;
  const int block_len = salt_len + 4;

  uint8_t U[64];
  uint8_t T[64];
  hmac_sha512_device(password, pass_len, salt_block, block_len, U);
  for (int i = 0; i < 64; i++) T[i] = U[i];
  for (int iter = 1; iter < iterations; iter++) {
    hmac_sha512_device(password, pass_len, U, 64, U);
    for (int i = 0; i < 64; i++) T[i] ^= U[i];
  }
  memcpy(out64, T, 64);
}

__device__ void bip32_master_device(const uint8_t* bip39_seed64, uint8_t priv32[32], uint8_t chain32[32]) {
  static const uint8_t kKey[] = {'B', 'i', 't', 'c', 'o', 'i', 'n', ' ', 's', 'e', 'e', 'd'};
  uint8_t mac[64];
  hmac_sha512_device(kKey, 12, bip39_seed64, 64, mac);
  memcpy(priv32, mac, 32);
  memcpy(chain32, mac + 32, 32);
}

__device__ void entropy_to_mnemonic_device(const uint8_t entropy[32], const char* words, const int* word_lens,
                                           char* mnemonic_out, int* mnemonic_len) {
  uint8_t hash[32];
  hash160_sha256_bytes(entropy, 32, hash);

  bool bits[264];
  for (int i = 0; i < 256; i++) {
    const uint8_t b = entropy[i / 8];
    bits[i] = (b >> (7 - (i % 8))) & 1;
  }
  for (int i = 0; i < 8; i++) {
    bits[256 + i] = (hash[0] >> (7 - i)) & 1;
  }

  int pos = 0;
  for (int w = 0; w < 24; w++) {
    if (w > 0) mnemonic_out[pos++] = ' ';
    uint32_t idx = 0;
    for (int j = 0; j < 11; j++) {
      idx = (idx << 1) | (bits[w * 11 + j] ? 1 : 0);
    }
    const char* word = words + idx * kWordMaxLen;
    const int wlen = word_lens[idx];
    for (int c = 0; c < wlen; c++) mnemonic_out[pos++] = word[c];
  }
  mnemonic_out[pos] = 0;
  *mnemonic_len = pos;
}

__device__ void seed_to_master_device(uint32_t pad, uint32_t prior_draws, const char* words, const int* word_lens,
                                      uint8_t master64[64]) {
  YasmarangDeviceState mp{};
  YasmarangDeviceState lib{};
  yasmarang_mp_cold_start(mp, pad);
  yasmarang_libngu_mk3_init(lib);
  for (uint32_t i = 0; i < prior_draws; i++) {
    yasmarang_device_step(mp);
    yasmarang_device_step(lib);
  }

  uint8_t raw[32];
  my_random_bytes_device(mp, lib, raw, 32);

  uint8_t entropy[32];
  sha256d_device(raw, 32, entropy);

  char mnemonic[280];
  int mnemonic_len = 0;
  entropy_to_mnemonic_device(entropy, words, word_lens, mnemonic, &mnemonic_len);

  static const uint8_t kSalt[] = "mnemonic";
  uint8_t bip39_seed[64];
  pbkdf2_hmac_sha512_device(reinterpret_cast<const uint8_t*>(mnemonic), mnemonic_len, kSalt, 8, 2048, bip39_seed);

  uint8_t priv[32];
  uint8_t chain[32];
  bip32_master_device(bip39_seed, priv, chain);
  memcpy(master64, priv, 32);
  memcpy(master64 + 32, chain, 32);
}

__global__ void seeds_to_masters_kernel(const uint32_t* pads, const uint32_t* sessions, int count, const char* words,
                                      const int* word_lens, uint8_t* masters64) {
  const int idx = blockIdx.x * blockDim.x + threadIdx.x;
  if (idx >= count) return;
  seed_to_master_device(pads[idx], sessions[idx], words, word_lens, masters64 + idx * 64);
}

bool load_bip39_wordlist_host(std::vector<char>& flat, std::vector<int>& lens, char* err, int err_cap) {
  std::ifstream in("config/bip39_english.txt");
  if (!in) in.open("../config/bip39_english.txt");
  if (!in) {
    snprintf(err, err_cap, "cannot open bip39 wordlist");
    return false;
  }
  flat.assign(kWordCount * kWordMaxLen, '\0');
  lens.assign(kWordCount, 0);
  std::string line;
  int wi = 0;
  while (std::getline(in, line) && wi < kWordCount) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty()) continue;
    if (static_cast<int>(line.size()) >= kWordMaxLen) {
      snprintf(err, err_cap, "bip39 word too long at index %d", wi);
      return false;
    }
    lens[wi] = static_cast<int>(line.size());
    memcpy(flat.data() + wi * kWordMaxLen, line.data(), line.size());
    wi++;
  }
  if (wi != kWordCount) {
    snprintf(err, err_cap, "bip39 wordlist expected %d words, got %d", kWordCount, wi);
    return false;
  }
  return true;
}

}  // namespace

extern "C" int cuda_seed_pipeline_init(char* err, int err_cap) {
  if (g_bip39_words_dev) return 1;
  std::vector<char> flat;
  std::vector<int> lens;
  if (!load_bip39_wordlist_host(flat, lens, err, err_cap)) return 0;

  cudaError_t e = cudaMalloc(&g_bip39_words_dev, flat.size());
  if (e != cudaSuccess) {
    snprintf(err, err_cap, "cudaMalloc words: %s", cudaGetErrorString(e));
    return 0;
  }
  e = cudaMemcpy(g_bip39_words_dev, flat.data(), flat.size(), cudaMemcpyHostToDevice);
  if (e != cudaSuccess) {
    cudaFree(g_bip39_words_dev);
    g_bip39_words_dev = nullptr;
    snprintf(err, err_cap, "cudaMemcpy words: %s", cudaGetErrorString(e));
    return 0;
  }
  e = cudaMalloc(&g_bip39_lens_dev, lens.size() * sizeof(int));
  if (e != cudaSuccess) {
    cudaFree(g_bip39_words_dev);
    g_bip39_words_dev = nullptr;
    snprintf(err, err_cap, "cudaMalloc lens: %s", cudaGetErrorString(e));
    return 0;
  }
  e = cudaMemcpy(g_bip39_lens_dev, lens.data(), lens.size() * sizeof(int), cudaMemcpyHostToDevice);
  if (e != cudaSuccess) {
    cudaFree(g_bip39_words_dev);
    cudaFree(g_bip39_lens_dev);
    g_bip39_words_dev = nullptr;
    g_bip39_lens_dev = nullptr;
    snprintf(err, err_cap, "cudaMemcpy lens: %s", cudaGetErrorString(e));
    return 0;
  }
  return 1;
}

extern "C" void cuda_seed_pipeline_shutdown() {
  if (g_bip39_words_dev) {
    cudaFree(g_bip39_words_dev);
    g_bip39_words_dev = nullptr;
  }
  if (g_bip39_lens_dev) {
    cudaFree(g_bip39_lens_dev);
    g_bip39_lens_dev = nullptr;
  }
}

extern "C" int cuda_batch_seeds_to_masters(const uint32_t* pads_host, const uint32_t* sessions_host, int count,
                                           uint8_t* masters_host, char* err, int err_cap) {
  if (!g_bip39_words_dev) {
    if (!cuda_seed_pipeline_init(err, err_cap)) return 0;
  }
  if (count <= 0) return 1;

  uint32_t *pads_dev = nullptr, *sessions_dev = nullptr;
  uint8_t* masters_dev = nullptr;
  cudaError_t e = cudaSuccess;

  e = cudaMalloc(&pads_dev, count * sizeof(uint32_t));
  if (e != cudaSuccess) goto fail;
  e = cudaMalloc(&sessions_dev, count * sizeof(uint32_t));
  if (e != cudaSuccess) goto fail;
  e = cudaMalloc(&masters_dev, static_cast<size_t>(count) * 64);
  if (e != cudaSuccess) goto fail;

  e = cudaMemcpy(pads_dev, pads_host, count * sizeof(uint32_t), cudaMemcpyHostToDevice);
  if (e != cudaSuccess) goto fail;
  e = cudaMemcpy(sessions_dev, sessions_host, count * sizeof(uint32_t), cudaMemcpyHostToDevice);
  if (e != cudaSuccess) goto fail;

  {
    const int blocks = (count + kThreads - 1) / kThreads;
    seeds_to_masters_kernel<<<blocks, kThreads>>>(pads_dev, sessions_dev, count, g_bip39_words_dev, g_bip39_lens_dev,
                                                  masters_dev);
    e = cudaGetLastError();
    if (e != cudaSuccess) goto fail;
    e = cudaDeviceSynchronize();
    if (e != cudaSuccess) goto fail;
  }

  e = cudaMemcpy(masters_host, masters_dev, static_cast<size_t>(count) * 64, cudaMemcpyDeviceToHost);
  if (e != cudaSuccess) goto fail;

  cudaFree(pads_dev);
  cudaFree(sessions_dev);
  cudaFree(masters_dev);
  return 1;

fail:
  snprintf(err, err_cap, "cuda_batch_seeds_to_masters: %s", cudaGetErrorString(e));
  if (pads_dev) cudaFree(pads_dev);
  if (sessions_dev) cudaFree(sessions_dev);
  if (masters_dev) cudaFree(masters_dev);
  return 0;
}

extern "C" int cuda_seed_pipeline_selftest(char* err, int err_cap) {
  const uint32_t pads[] = {0x00400001};
  const uint32_t sessions[] = {8};
  uint8_t gpu_master[64] = {};
  if (!cuda_batch_seeds_to_masters(pads, sessions, 1, gpu_master, err, err_cap)) return 0;
  return 1;
}
