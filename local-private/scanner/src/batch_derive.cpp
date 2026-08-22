#include "scanner/batch_derive.hpp"

#include "scanner/bip32.hpp"
#include "scanner/bip32_internal.hpp"
#include "scanner/bip39.hpp"

#include <openssl/crypto.h>
#include <openssl/provider.h>

#include <cstring>
#include <iostream>
#include <map>
#include <string>
#include <tuple>

namespace scanner {

static void ensure_openssl() {
  OPENSSL_init_crypto(OPENSSL_INIT_LOAD_CRYPTO_STRINGS, nullptr);
  OSSL_PROVIDER_load(nullptr, "default");
}

ScriptFamily script_family_from_path(const DerivationPath& path) {
  if (path.script_type == "bip49") return ScriptFamily::Bip49;
  if (path.script_type == "bip44") return ScriptFamily::Bip44;
  return ScriptFamily::Bip84;
}

static void path_indices(const DerivationPath& p, std::vector<uint32_t>& path_idx, std::vector<bool>& hardened) {
  if (p.script_type == "bip84") {
    path_idx = {84, 0, p.account, p.branch, p.index};
    hardened = {true, true, true, false, false};
  } else if (p.script_type == "bip49") {
    path_idx = {49, 0, p.account, 0, p.index};
    hardened = {true, true, true, false, false};
  } else {
    path_idx = {44, 0, 0, 0, p.index};
    hardened = {true, true, true, false, false};
  }
}

std::vector<uint8_t> derive_privkeys_for_seed(const std::vector<uint8_t>& entropy,
                                              const std::vector<DerivationPath>& paths) {
  ensure_openssl();
  std::vector<uint8_t> out;
  const auto seed = bip39_seed_from_entropy(entropy);
  if (seed.empty()) return out;
  const Bip32Key master = bip32_master(seed);
  if (master.priv32.size() != 32 || master.chain32.size() != 32) return {};
  out.resize(paths.size() * 32);
  for (size_t pi = 0; pi < paths.size(); pi++) {
    std::vector<uint32_t> path_idx;
    std::vector<bool> hardened;
    path_indices(paths[pi], path_idx, hardened);
    const Bip32Key key = bip32_internal::derive_path(master, path_idx, hardened);
    if (key.priv32.size() != 32) {
      std::cerr << "derive_privkeys failed at path " << pi << " (" << paths[pi].script_type << ")\n";
      return {};
    }
    memcpy(out.data() + pi * 32, key.priv32.data(), 32);
  }
  return out;
}

std::vector<uint8_t> derive_privkeys_batch(const std::vector<SeedCandidate>& seeds,
                                           const std::vector<DerivationPath>& paths) {
  std::vector<uint8_t> out(seeds.size() * paths.size() * 32);
  for (size_t si = 0; si < seeds.size(); si++) {
    const auto row = derive_privkeys_for_seed(seeds[si].entropy, paths);
    if (row.size() != paths.size() * 32) continue;
    memcpy(out.data() + si * paths.size() * 32, row.data(), row.size());
  }
  return out;
}

std::vector<uint8_t> masters_for_seeds(const std::vector<SeedCandidate>& seeds) {
  ensure_openssl();
  std::vector<uint8_t> out(seeds.size() * 64);
  for (size_t si = 0; si < seeds.size(); si++) {
    const auto seed = bip39_seed_from_entropy(seeds[si].entropy);
    if (seed.empty()) continue;
    const Bip32Key master = bip32_master(seed);
    if (master.priv32.size() != 32 || master.chain32.size() != 32) continue;
    memcpy(out.data() + si * 64, master.priv32.data(), 32);
    memcpy(out.data() + si * 64 + 32, master.chain32.data(), 32);
  }
  return out;
}

static std::string prefix_key(const DerivationPath& p) {
  return p.script_type + ":" + std::to_string(p.account) + ":" + std::to_string(p.branch);
}

PathLayout build_path_layout(const std::vector<DerivationPath>& paths) {
  PathLayout layout;
  std::map<std::string, uint16_t> prefix_ids;

  for (size_t pi = 0; pi < paths.size(); pi++) {
    const auto& p = paths[pi];
    std::vector<uint32_t> path_idx;
    std::vector<bool> hardened;
    path_indices(p, path_idx, hardened);

    const std::string key = prefix_key(p);
    uint16_t prefix_id = 0;
    const auto it = prefix_ids.find(key);
    if (it == prefix_ids.end()) {
      prefix_id = static_cast<uint16_t>(layout.prefixes.size());
      prefix_ids[key] = prefix_id;
      CudaPrefixDesc pref{};
      for (int i = 0; i < 4; i++) {
        pref.step_index[i] = path_idx[i];
        pref.step_hardened[i] = hardened[i] ? 1 : 0;
      }
      pref.family = static_cast<uint8_t>(script_family_from_path(p));
      pref._pad[0] = pref._pad[1] = pref._pad[2] = 0;
      layout.prefixes.push_back(pref);
    } else {
      prefix_id = it->second;
    }

    CudaLeafDesc leaf{};
    leaf.prefix_id = prefix_id;
    leaf.path_index = static_cast<uint16_t>(pi);
    leaf.step4_index = path_idx[4];
    leaf.family = static_cast<uint8_t>(script_family_from_path(p));
    leaf._pad[0] = leaf._pad[1] = leaf._pad[2] = 0;
    layout.leaves.push_back(leaf);
  }

  return layout;
}

std::vector<uint8_t> derive_privkey_for_path(const std::vector<uint8_t>& entropy, const DerivationPath& path) {
  ensure_openssl();
  const auto seed = bip39_seed_from_entropy(entropy);
  if (seed.empty()) return {};
  const Bip32Key master = bip32_master(seed);
  if (master.priv32.size() != 32 || master.chain32.size() != 32) return {};
  std::vector<uint32_t> path_idx;
  std::vector<bool> hardened;
  path_indices(path, path_idx, hardened);
  const Bip32Key key = bip32_internal::derive_path(master, path_idx, hardened);
  if (key.priv32.size() != 32) return {};
  return key.priv32;
}

std::vector<CudaPathDesc> build_cuda_path_descs(const std::vector<DerivationPath>& paths) {
  std::vector<CudaPathDesc> out(paths.size());
  for (size_t pi = 0; pi < paths.size(); pi++) {
    std::vector<uint32_t> path_idx;
    std::vector<bool> hardened;
    path_indices(paths[pi], path_idx, hardened);
    CudaPathDesc& d = out[pi];
    for (int i = 0; i < 5; i++) {
      d.step_index[i] = path_idx[i];
      d.step_hardened[i] = hardened[i] ? 1 : 0;
    }
    d.family = static_cast<uint8_t>(script_family_from_path(paths[pi]));
    d._pad[0] = d._pad[1] = 0;
  }
  return out;
}

}  // namespace scanner
