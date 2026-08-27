#include "scanner/verify.hpp"

#include "scanner/address_encode.hpp"
#include "scanner/batch_derive.hpp"
#include "scanner/bip32.hpp"
#include "scanner/bip32_internal.hpp"
#include "scanner/bip39.hpp"
#include "scanner/bitcoin_derive.hpp"
#include "scanner/crypto_aes.hpp"
#include "scanner/coldcard_seed.hpp"
#include "scanner/gpu_engine.hpp"
#include "scanner/victim_loader.hpp"
#include "scanner/yasmarang.hpp"

#include "cuda/gpu_api.h"

#include <openssl/crypto.h>
#include <openssl/hmac.h>
#include <openssl/provider.h>
#include <openssl/sha.h>

#include <algorithm>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

namespace scanner {

namespace {

struct FixtureAddress {
  std::vector<uint8_t> entropy;
  std::string address;
  std::string mnemonic;
  size_t path_index = 0;
};

bool paths_equal(const DerivationPath& a, const DerivationPath& b) {
  return a.script_type == b.script_type && a.account == b.account && a.branch == b.branch && a.index == b.index;
}

std::optional<size_t> find_path_index(const std::vector<DerivationPath>& paths, const DerivationPath& target) {
  for (size_t i = 0; i < paths.size(); i++) {
    if (paths_equal(paths[i], target)) return i;
  }
  return std::nullopt;
}

FixtureAddress derive_fixture_address(uint32_t pad, uint32_t scan_session, const DerivationPath& path,
                                      const std::vector<DerivationPath>& paths) {
  FixtureAddress out;
  out.entropy = coldcard_seed_entropy(pad, scan_session);
  out.mnemonic = entropy_to_mnemonic(out.entropy);
  const auto path_index = find_path_index(paths, path);
  if (!path_index.has_value()) return out;
  out.path_index = *path_index;

  const auto priv = derive_privkey_for_path(out.entropy, path);
  if (priv.size() != 32) return out;
  const auto pub = bip32_internal::privkey_to_pubkey33(priv);
  const auto pk_hash = hash160(pub);
  out.address = encode_address_for_path(path, pub.data(), pk_hash.data());
  return out;
}

std::optional<GpuHit> find_hit_for_seed(const std::vector<GpuHit>& hits, uint32_t seed_index) {
  for (const auto& hit : hits) {
    if (hit.seed_index == seed_index) return hit;
  }
  return std::nullopt;
}

int run_verify_parity(const ScanConfig& cfg) {
  const auto paths = build_derivation_paths(cfg);
  std::cerr << "verify: derive privkeys (" << paths.size() << " paths)…" << std::flush;
  const auto e1 = coldcard_seed_entropy(0x00400001, 8);
  const auto privkeys = derive_privkeys_for_seed(e1, paths);
  if (privkeys.size() != paths.size() * 32) {
    std::cerr << "\nverify failed: batch privkey size\n";
    return 1;
  }
  std::cerr << " ok\n";

  {
    uint8_t one_priv[32] = {};
    one_priv[31] = 1;
    uint8_t one_pub[33] = {};
    char err2[512] = {};
    if (!cuda_secp256k1_batch_pubkeys(one_priv, one_pub, 1, err2, sizeof(err2))) {
      std::cerr << "\nverify failed: secp generator: " << err2 << "\n";
      return 1;
    }
    static const uint8_t kGx[32] = {0x79, 0xBE, 0x66, 0x7E, 0xF9, 0xDC, 0xBB, 0xAC, 0x55, 0xA0, 0x62, 0x95,
                                    0xCE, 0x87, 0x0B, 0x07, 0x02, 0x9B, 0xFC, 0xDB, 0x2D, 0xCE, 0x28, 0xD9,
                                    0x59, 0xF2, 0x81, 0x5B, 0x16, 0xF8, 0x17, 0x98};
    if (one_pub[0] != 0x02 && one_pub[0] != 0x03) {
      std::cerr << "\nverify failed: secp generator invalid prefix\n";
      return 1;
    }
    if (memcmp(one_pub + 1, kGx, 32) != 0) {
      std::cerr << "\nverify failed: secp generator x mismatch\n";
      return 1;
    }
    uint8_t two_priv[32] = {};
    two_priv[31] = 2;
    uint8_t two_pub[33] = {};
    if (!cuda_secp256k1_batch_pubkeys(two_priv, two_pub, 1, err2, sizeof(err2))) {
      std::cerr << "\nverify failed: secp 2G: " << err2 << "\n";
      return 1;
    }
    const auto two_cpu = bip32_internal::privkey_to_pubkey33(std::vector<uint8_t>(two_priv, two_priv + 32));
    if (two_cpu.size() != 33 || memcmp(two_cpu.data(), two_pub, 33) != 0) {
      std::cerr << "\nverify failed: CPU/CUDA secp mismatch for scalar 2\n";
      return 1;
    }
  }

  const int work_count = static_cast<int>(paths.size());
  std::vector<uint8_t> pubkeys(static_cast<size_t>(work_count) * 33);
  char err[512] = {};
  std::cerr << "verify: secp256k1 pubkeys…" << std::flush;
  if (!cuda_secp256k1_batch_pubkeys(privkeys.data(), pubkeys.data(), work_count, err, sizeof(err))) {
    std::cerr << "\nverify failed: secp batch: " << err << "\n";
    return 1;
  }
  std::cerr << " ok\n";

  SeedCandidate sc;
  sc.pad = 0x00400001;
  sc.scan_session = 8;
  sc.entropy = e1;
  const auto masters = masters_for_seeds({sc});

  {
    const uint32_t pads[] = {sc.pad};
    const uint32_t sessions[] = {sc.scan_session};
    uint8_t gpu_master[64] = {};
    char err_seed[512] = {};
    if (!cuda_batch_seeds_to_masters(pads, sessions, 1, gpu_master, err_seed, sizeof(err_seed))) {
      std::cerr << "\nverify failed: GPU seed batch: " << err_seed << "\n";
      return 1;
    }
    if (memcmp(gpu_master, masters.data(), 64) != 0) {
      std::cerr << "\nverify failed: CPU/GPU master mismatch for pad/session fixture\n";
      return 1;
    }
  }

  const auto cuda_paths = build_cuda_path_descs(paths);

  {
    const auto seed = bip39_seed_from_entropy(e1);
    const Bip32Key master = bip32_master(seed);
    std::vector<uint32_t> pi1 = {84};
    std::vector<bool> h1 = {true};
    const Bip32Key k1 = bip32_internal::derive_path(master, pi1, h1);
    std::vector<uint8_t> gpu1(32);
    std::vector<uint8_t> data(37);
    data[0] = 0;
    memcpy(data.data() + 1, master.priv32.data(), 32);
    data[33] = 0x80;
    data[34] = 0x00;
    data[35] = 0x00;
    data[36] = 0x54;
    unsigned char mac[64];
    unsigned int mac_len = 64;
    HMAC(EVP_sha512(), master.chain32.data(), 32, data.data(), data.size(), mac, &mac_len);
    uint8_t gpu_mac[64] = {};
    if (!cuda_hmac_sha512(master.chain32.data(), 32, data.data(), static_cast<int>(data.size()), gpu_mac, err,
                          sizeof(err))) {
      std::cerr << "\nverify failed: GPU HMAC: " << err << "\n";
      return 1;
    }
    if (memcmp(mac, gpu_mac, 64) != 0) {
      std::cerr << "\nverify failed: CPU/GPU HMAC mismatch\n";
      return 1;
    }
    if (!cuda_derive_privkeys_from_masters_steps(masters.data(), 1, cuda_paths.data(), 1, 1, gpu1.data(), err,
                                                 sizeof(err))) {
      std::cerr << "\nverify failed: GPU BIP32 1-step: " << err << "\n";
      return 1;
    }
    if (memcmp(k1.priv32.data(), gpu1.data(), 32) != 0) {
      std::cerr << "\nverify failed: CPU/GPU privkey mismatch after 1 hardened step\n";
      return 1;
    }
  }

  {
    std::vector<uint8_t> gpu_privkeys(paths.size() * 32);
    std::cerr << "verify: full GPU BIP32 privkeys…" << std::flush;
    if (!cuda_derive_privkeys_from_masters(masters.data(), 1, cuda_paths.data(), static_cast<int>(paths.size()),
                                           gpu_privkeys.data(), err, sizeof(err))) {
      std::cerr << "\nverify failed: GPU full BIP32: " << err << "\n";
      return 1;
    }
    for (size_t i = 0; i < paths.size(); i++) {
      if (memcmp(privkeys.data() + i * 32, gpu_privkeys.data() + i * 32, 32) != 0) {
        std::cerr << "\nverify failed: CPU/GPU full privkey mismatch at path " << i << "\n";
        return 1;
      }
    }
    std::cerr << " ok\n";
  }

  {
    std::vector<uint8_t> gpu_pubkeys(paths.size() * 33);
    std::cerr << "verify: full GPU BIP32 pubkeys…" << std::flush;
    if (!cuda_derive_pubkeys_from_masters(masters.data(), 1, cuda_paths.data(), static_cast<int>(paths.size()),
                                          gpu_pubkeys.data(), err, sizeof(err))) {
      std::cerr << "\nverify failed: GPU full pubkeys: " << err << "\n";
      return 1;
    }
    for (size_t i = 0; i < paths.size(); i++) {
      const auto cpu_pub = bip32_internal::privkey_to_pubkey33(
          std::vector<uint8_t>(privkeys.begin() + i * 32, privkeys.begin() + i * 32 + 32));
      if (cpu_pub.size() != 33 || memcmp(cpu_pub.data(), gpu_pubkeys.data() + i * 33, 33) != 0) {
        std::cerr << "\nverify failed: CPU/GPU full pubkey mismatch at path " << i << "\n";
        return 1;
      }
    }
    std::cerr << " ok\n";
  }

  const auto layout = build_path_layout(paths);
  {
    std::vector<uint8_t> dedup_privkeys(paths.size() * 32);
    std::cerr << "verify: dedup GPU BIP32 privkeys…" << std::flush;
    if (!cuda_derive_leaf_privkeys_dedup(masters.data(), 1, layout.prefixes.data(),
                                         static_cast<int>(layout.prefixes.size()), layout.leaves.data(),
                                         static_cast<int>(layout.leaves.size()), dedup_privkeys.data(), err,
                                         sizeof(err))) {
      std::cerr << "\nverify failed: dedup privkeys: " << err << "\n";
      return 1;
    }
    for (size_t i = 0; i < paths.size(); i++) {
      if (memcmp(privkeys.data() + i * 32, dedup_privkeys.data() + i * 32, 32) != 0) {
        std::cerr << "\nverify failed: CPU/dedup privkey mismatch at path " << i << "\n";
        return 1;
      }
    }
    std::cerr << " ok\n";
  }

  {
    std::vector<uint8_t> dedup_pubkeys(paths.size() * 33);
    std::cerr << "verify: dedup GPU BIP32 pubkeys…" << std::flush;
    if (!cuda_derive_leaf_pubkeys_dedup(masters.data(), 1, layout.prefixes.data(),
                                        static_cast<int>(layout.prefixes.size()), layout.leaves.data(),
                                        static_cast<int>(layout.leaves.size()), dedup_pubkeys.data(), err,
                                        sizeof(err))) {
      std::cerr << "\nverify failed: dedup pubkeys: " << err << "\n";
      return 1;
    }
    for (size_t i = 0; i < paths.size(); i++) {
      const auto cpu_pub = bip32_internal::privkey_to_pubkey33(
          std::vector<uint8_t>(privkeys.begin() + i * 32, privkeys.begin() + i * 32 + 32));
      if (cpu_pub.size() != 33 || memcmp(cpu_pub.data(), dedup_pubkeys.data() + i * 33, 33) != 0) {
        std::cerr << "\nverify failed: CPU/dedup pubkey mismatch at path " << i << "\n";
        return 1;
      }
    }
    std::cerr << " ok\n";
  }

  std::vector<uint8_t> families;
  families.reserve(paths.size());
  for (const auto& p : paths) families.push_back(static_cast<uint8_t>(script_family_from_path(p)));

  std::vector<uint8_t> gpu_hashes(static_cast<size_t>(work_count) * 20);
  std::cerr << "verify: GPU hash160…" << std::flush;
  if (!cuda_hash160_batch(pubkeys.data(), families.data(), work_count, static_cast<int>(paths.size()), gpu_hashes.data(),
                          err, sizeof(err))) {
    std::cerr << "\nverify failed: GPU hash160: " << err << "\n";
    return 1;
  }
  std::cerr << " ok\n";

  std::cerr << "verify: parity check…" << std::flush;
  const int parity_paths = std::min(16, static_cast<int>(paths.size()));
  for (int i = 0; i < parity_paths; i++) {
    std::vector<uint8_t> priv(privkeys.begin() + i * 32, privkeys.begin() + i * 32 + 32);
    const auto cpu_pub = bip32_internal::privkey_to_pubkey33(priv);
    const auto cpu_pub_hash = hash160(cpu_pub);
    uint8_t cpu_lookup[20];
    if (paths[i].script_type == "bip49") {
      std::vector<uint8_t> redeem = {0x00, 0x14};
      redeem.insert(redeem.end(), cpu_pub_hash.begin(), cpu_pub_hash.end());
      const auto script_hash = hash160(redeem);
      memcpy(cpu_lookup, script_hash.data(), 20);
    } else {
      memcpy(cpu_lookup, cpu_pub_hash.data(), 20);
    }
    if (memcmp(cpu_lookup, gpu_hashes.data() + i * 20, 20) != 0) {
      std::cerr << "verify failed: CPU/GPU hash160 mismatch at path " << i << "\n";
      return 1;
    }
    const std::string encoded = encode_address_for_path(paths[i], cpu_pub.data(), cpu_pub_hash.data());
    if (encoded.empty()) {
      std::cerr << "\nverify failed: empty address at path " << i << "\n";
      return 1;
    }
  }
  std::cerr << " ok\n";

  std::vector<uint8_t> priv0(privkeys.begin(), privkeys.begin() + 32);
  const auto pub0 = bip32_internal::privkey_to_pubkey33(priv0);
  const auto h0 = hash160(pub0);
  const std::string sample = encode_address_for_path(paths[0], pub0.data(), h0.data());

  std::cout << "verify OK — device secp, full GPU BIP32, dedup prefix pipeline (" << paths.size()
            << " paths), hash160 parity (" << parity_paths << " paths), sample address: " << sample << "\n";
  return 0;
}

int run_verify_e2e_match(const ScanConfig& cfg) {
  struct FixtureSpec {
    const char* label;
    uint32_t pad;
    uint32_t scan_session;
    DerivationPath path;
  };

  const std::vector<FixtureSpec> fixtures = {
      {"bip84", 0x00400001, 8, {"bip84", 0, 0, 0}},
      {"bip49", 0x00400002, 8, {"bip49", 0, 0, 0}},
      {"bip44", 0x00400001, 9, {"bip44", 0, 0, 0}},
  };

  const auto paths = build_derivation_paths(cfg);
  std::string err;

  std::vector<FixtureAddress> derived;
  derived.reserve(fixtures.size());
  for (const auto& fx : fixtures) {
  const auto fixture = derive_fixture_address(fx.pad, fx.scan_session, fx.path, paths);
    if (fixture.address.empty() || fixture.mnemonic.empty()) {
      std::cerr << "verify --match failed: could not derive fixture for " << fx.label << "\n";
      return 1;
    }
    derived.push_back(fixture);
  }

  VictimSet victims;
  for (const auto& fixture : derived) {
    if (!victims.add_address(fixture.address, err)) {
      std::cerr << "verify --match failed: " << err << "\n";
      return 1;
    }
  }

  GpuEngine gpu;
  if (!gpu.init(cfg.gpu_device_index, victims, paths, err)) {
    std::cerr << "verify --match failed: GPU init: " << err << "\n";
    return 1;
  }
  gpu.set_utilization_cap(100);

  std::vector<SeedCandidate> seeds;
  for (const auto& fx : fixtures) {
    SeedCandidate sc;
    sc.pad = fx.pad;
    sc.scan_session = fx.scan_session;
    seeds.push_back(sc);
  }
  SeedCandidate negative;
  negative.pad = 0x00400003;
  negative.scan_session = 8;
  seeds.push_back(negative);

  std::vector<GpuHit> hits;
  std::cerr << "verify --match: GPU fused pipeline (" << seeds.size() << " seeds × " << paths.size()
            << " paths)…" << std::flush;
  if (!gpu.process_candidate_batch(seeds, hits, err)) {
    std::cerr << "\nverify --match failed: " << err << "\n";
    return 1;
  }
  std::cerr << " ok\n";

  if (hits.size() != 3) {
    std::cerr << "verify --match failed: expected 3 hits, got " << hits.size() << "\n";
    return 1;
  }

  for (size_t i = 0; i < fixtures.size(); i++) {
    const auto hit = find_hit_for_seed(hits, static_cast<uint32_t>(i));
    if (!hit.has_value()) {
      std::cerr << "verify --match failed: no hit for seed index " << i << " (" << fixtures[i].label << ")\n";
      return 1;
    }
    if (hit->path_index != derived[i].path_index) {
      std::cerr << "verify --match failed: path_index mismatch for " << fixtures[i].label << " (expected "
                << derived[i].path_index << ", got " << hit->path_index << ")\n";
      return 1;
    }
    if (hit->victim_index != i) {
      std::cerr << "verify --match failed: victim_index mismatch for " << fixtures[i].label << " (expected " << i
                << ", got " << hit->victim_index << ")\n";
      return 1;
    }

    const auto& path = paths[derived[i].path_index];
    const auto entropy = coldcard_seed_entropy(fixtures[i].pad, fixtures[i].scan_session);
    const auto priv = derive_privkey_for_path(entropy, path);
    if (priv.size() != 32) {
      std::cerr << "verify --match failed: CPU re-derive privkey for " << fixtures[i].label << "\n";
      return 1;
    }
    const auto pub = bip32_internal::privkey_to_pubkey33(priv);
    const auto pk_hash = hash160(pub);
    const std::string address = encode_address_for_path(path, pub.data(), pk_hash.data());
    if (address != derived[i].address) {
      std::cerr << "verify --match failed: CPU address mismatch for " << fixtures[i].label << "\n";
      return 1;
    }
    const VictimEntry* victim = victims.find_by_address(address);
    if (!victim || victim->address != derived[i].address) {
      std::cerr << "verify --match failed: victim lookup for " << fixtures[i].label << "\n";
      return 1;
    }

    std::cout << "e2e match " << fixtures[i].label << " pad=0x" << std::hex << fixtures[i].pad << std::dec
              << " session=" << fixtures[i].scan_session << " path_index=" << derived[i].path_index
              << " address=" << derived[i].address << " mnemonic=" << derived[i].mnemonic << "\n";
  }

  if (find_hit_for_seed(hits, 3).has_value()) {
    std::cerr << "verify --match failed: false positive from negative seed (index 3)\n";
    return 1;
  }

  std::cout << "e2e match OK (3 hits, 0 false positives)\n";
  return 0;
}

}  // namespace

int run_verify(bool include_match, const ScanConfig& cfg) {
  OPENSSL_init_crypto(OPENSSL_INIT_LOAD_CRYPTO_STRINGS, nullptr);
  OSSL_PROVIDER_load(nullptr, "default");

  std::cerr << "verify: yasmarang…" << std::flush;
  YasmarangRng rng1;
  rng1.reset_cold_start(0x12345678);
  const uint32_t a = rng1.rng_get();
  YasmarangRng rng2;
  rng2.reset_cold_start(0x12345678);
  const uint32_t b = rng2.rng_get();
  if (a != b) {
    std::cerr << "\nverify failed: yasmarang not deterministic\n";
    return 1;
  }
  std::cerr << " ok\n";

  {
    char err0[512] = {};
    std::cerr << "verify: device SHA-512…" << std::flush;
    if (!cuda_crypto_selftest(err0, sizeof(err0))) {
      std::cerr << "\nverify failed: " << err0 << "\n";
      return 1;
    }
    std::cerr << " ok\n";
  }

  {
    char err_seed[512] = {};
    std::cerr << "verify: GPU seed pipeline…" << std::flush;
    if (!cuda_seed_pipeline_selftest(err_seed, sizeof(err_seed))) {
      std::cerr << "\nverify failed: " << err_seed << "\n";
      return 1;
    }
    std::cerr << " ok\n";
  }

  {
    LibnguYasmarang lib1;
    LibnguYasmarang lib2;
    if (lib1.rng_get() != lib2.rng_get()) {
      std::cerr << "verify failed: libngu yasmarang not deterministic\n";
      return 1;
    }
  }

  {
    const std::vector<uint8_t> msg = {'a', 'b', 'c'};
    const auto d = sha256d(msg);
    if (d.size() != 32) {
      std::cerr << "verify failed: sha256d size\n";
      return 1;
    }
    const auto d2 = sha256d(msg);
    if (d != d2) {
      std::cerr << "verify failed: sha256d not deterministic\n";
      return 1;
    }
  }

  const auto e1 = coldcard_seed_entropy(0x00400001, 8);
  const auto e2 = coldcard_seed_entropy(0x00400001, 8);
  if (e1 != e2 || e1.size() != 32) {
    std::cerr << "verify failed: seed entropy\n";
    return 1;
  }

  const int parity_rc = run_verify_parity(cfg);
  if (parity_rc != 0) return parity_rc;

  if (!include_match) return 0;

  return run_verify_e2e_match(cfg);
}

}  // namespace scanner
