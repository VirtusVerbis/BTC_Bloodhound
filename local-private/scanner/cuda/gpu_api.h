#pragma once

#include <cstddef>
#include <cstdint>

#ifdef __cplusplus
extern "C" {
#endif

struct CudaVictimKey {
  uint8_t key20[20];
  uint32_t victim_index;
  uint8_t family;  // 0=bip84, 1=bip49, 2=bip44
};

struct CudaPathDesc {
  uint32_t step_index[5];
  uint8_t step_hardened[5];
  uint8_t family;
  uint8_t _pad[2];
};

// Steps 0-3 shared prefix (m/purpose'/coin'/account'/branch)
struct CudaPrefixDesc {
  uint32_t step_index[4];
  uint8_t step_hardened[4];
  uint8_t family;
  uint8_t _pad[3];
};

// Step 4 leaf (index) referencing a prefix group
struct CudaLeafDesc {
  uint16_t prefix_id;
  uint16_t path_index;
  uint32_t step4_index;
  uint8_t family;
  uint8_t _pad[3];
};

struct CudaGpuHit {
  uint32_t work_index;
  uint32_t victim_index;
  uint8_t hash20[20];
};

int cuda_probe_device(int device_index, char* name_out, int name_cap, size_t* vram_mb_out, char* err, int err_cap);

int cuda_engine_create(void** handle_out, int device_index, const CudaVictimKey* victims, int victim_count,
                       const CudaPathDesc* paths, int path_count, const CudaPrefixDesc* prefixes, int prefix_count,
                       const CudaLeafDesc* leaves, int leaf_count, char* err, int err_cap);

void cuda_engine_destroy(void* handle);

int cuda_engine_process_masters(void* handle, const uint8_t* masters64, int seed_count, CudaGpuHit* hits_out,
                                int* hit_count_out, double* elapsed_ms_out, char* err, int err_cap);

// Legacy / verify helpers
int cuda_engine_process_pubkeys(void* handle, const uint8_t* pubkeys33, int work_count, int path_count,
                                CudaGpuHit* hits_out, int* hit_count_out, double* elapsed_ms_out, char* err, int err_cap);

int cuda_secp256k1_batch_pubkeys(const uint8_t* privkeys, uint8_t* pubkeys33, int count, char* err, int err_cap);

int cuda_hash160_batch(const uint8_t* pubkeys33, const uint8_t* path_families, int work_count, int path_count,
                       uint8_t* hash20_out, char* err, int err_cap);

int cuda_derive_pubkeys_from_masters(const uint8_t* masters64, int seed_count, const CudaPathDesc* paths,
                                     int path_count, uint8_t* pubkeys33_out, char* err, int err_cap);

int cuda_derive_privkeys_from_masters(const uint8_t* masters64, int seed_count, const CudaPathDesc* paths,
                                      int path_count, uint8_t* privkeys32_out, char* err, int err_cap);

int cuda_derive_privkeys_from_masters_steps(const uint8_t* masters64, int seed_count, const CudaPathDesc* paths,
                                            int path_count, int num_steps, uint8_t* privkeys32_out, char* err,
                                            int err_cap);

int cuda_derive_leaf_privkeys_dedup(const uint8_t* masters64, int seed_count, const CudaPrefixDesc* prefixes,
                                    int prefix_count, const CudaLeafDesc* leaves, int leaf_count,
                                    uint8_t* privkeys32_out, char* err, int err_cap);

int cuda_derive_leaf_pubkeys_dedup(const uint8_t* masters64, int seed_count, const CudaPrefixDesc* prefixes,
                                   int prefix_count, const CudaLeafDesc* leaves, int leaf_count,
                                   uint8_t* pubkeys33_out, char* err, int err_cap);

int cuda_crypto_selftest(char* err, int err_cap);

int cuda_hmac_sha512(const uint8_t* key, int key_len, const uint8_t* data, int data_len, uint8_t* out64, char* err,
                     int err_cap);

// Mk3 seed pipeline: (pad, prior_draws) -> BIP32 master (priv32 + chain32 per seed).
int cuda_seed_pipeline_init(char* err, int err_cap);
void cuda_seed_pipeline_shutdown();
int cuda_batch_seeds_to_masters(const uint32_t* pads, const uint32_t* sessions, int count, uint8_t* masters64_out,
                                char* err, int err_cap);
int cuda_seed_pipeline_selftest(char* err, int err_cap);

#ifdef __cplusplus
}
#endif
