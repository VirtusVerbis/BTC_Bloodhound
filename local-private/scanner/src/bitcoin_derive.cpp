#include "scanner/bitcoin_derive.hpp"

#include "scanner/bip32.hpp"
#include "scanner/bip39.hpp"

#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/ec.h>
#include <openssl/obj_mac.h>
#include <openssl/sha.h>

#include <array>
#include <cstring>
#include <sstream>

namespace scanner {

namespace {

const char* BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

std::string base58_encode(const std::vector<uint8_t>& data) {
  std::vector<uint8_t> digits(1, 0);
  for (uint8_t byte : data) {
    int carry = byte;
    for (size_t i = 0; i < digits.size(); i++) {
      carry += static_cast<int>(digits[i]) << 8;
      digits[i] = static_cast<uint8_t>(carry % 58);
      carry /= 58;
    }
    while (carry > 0) {
      digits.push_back(static_cast<uint8_t>(carry % 58));
      carry /= 58;
    }
  }
  std::string out;
  for (uint8_t b : data) {
    if (b == 0) out.push_back(BASE58_ALPHABET[0]);
    else break;
  }
  for (auto it = digits.rbegin(); it != digits.rend(); ++it) out.push_back(BASE58_ALPHABET[*it]);
  return out;
}

std::string base58check_encode(const std::vector<uint8_t>& payload) {
  unsigned char hash1[SHA256_DIGEST_LENGTH];
  unsigned char hash2[SHA256_DIGEST_LENGTH];
  SHA256(payload.data(), payload.size(), hash1);
  SHA256(hash1, SHA256_DIGEST_LENGTH, hash2);
  std::vector<uint8_t> full(payload);
  full.insert(full.end(), hash2, hash2 + 4);
  return base58_encode(full);
}

const std::array<char, 32> BECH32_CHARSET = {
    'q', 'p', 'z', 'r', 'y', '9', 'x', '8', 'g', 'f', '2', 't', 'v', 'd', 'w', '0', 's', '3', 'j', 'n',
    '5', '4', 'k', 'h', 'c', 'e', '6', 'm', 'u', 'a', '7', 'l'};

uint32_t bech32_polymod(const std::vector<uint8_t>& values) {
  uint32_t chk = 1;
  for (uint8_t v : values) {
    chk ^= v;
    for (int i = 0; i < 8; i++) chk = (chk & 1) ? (0x2bc830a3 ^ (chk >> 1)) : (chk >> 1);
  }
  return chk;
}

std::vector<uint8_t> convert_bits(const std::vector<uint8_t>& in, int frombits, int tobits, bool pad) {
  std::vector<uint8_t> out;
  uint32_t acc = 0;
  int bits = 0;
  const uint32_t maxv = (1u << tobits) - 1;
  for (uint8_t value : in) {
    acc = (acc << frombits) | value;
    bits += frombits;
    while (bits >= tobits) {
      bits -= tobits;
      out.push_back(static_cast<uint8_t>((acc >> bits) & maxv));
    }
  }
  if (pad && bits > 0) out.push_back(static_cast<uint8_t>((acc << (tobits - bits)) & maxv));
  return out;
}

std::string bech32_encode(const std::string& hrp, const std::vector<uint8_t>& data) {
  std::vector<uint8_t> values;
  for (char c : hrp) values.push_back(static_cast<uint8_t>(c >> 5));
  values.push_back(0);
  for (char c : hrp) values.push_back(static_cast<uint8_t>(c & 31));
  values.insert(values.end(), data.begin(), data.end());
  const uint32_t mod = bech32_polymod(values);
  std::vector<uint8_t> checksum(6);
  uint32_t chk = mod ^ 1;
  for (int i = 0; i < 6; i++) checksum[i] = static_cast<uint8_t>((chk >> (5 * (5 - i))) & 31);

  std::string out = hrp + "1";
  for (uint8_t v : data) out.push_back(BECH32_CHARSET[v]);
  for (uint8_t v : checksum) out.push_back(BECH32_CHARSET[v]);
  return out;
}

EC_KEY* privkey_to_ec(const std::vector<uint8_t>& priv32) {
  EC_KEY* key = EC_KEY_new_by_curve_name(NID_secp256k1);
  BIGNUM* priv = BN_bin2bn(priv32.data(), static_cast<int>(priv32.size()), nullptr);
  EC_KEY_set_private_key(key, priv);
  const EC_GROUP* group = EC_KEY_get0_group(key);
  EC_POINT* pub = EC_POINT_new(group);
  EC_POINT_mul(group, pub, priv, nullptr, nullptr, nullptr);
  EC_KEY_set_public_key(key, pub);
  EC_POINT_free(pub);
  BN_free(priv);
  return key;
}

std::vector<uint8_t> serialize_pubkey_compressed(EC_KEY* key) {
  const EC_GROUP* group = EC_KEY_get0_group(key);
  const EC_POINT* pub = EC_KEY_get0_public_key(key);
  std::vector<uint8_t> out(33);
  EC_POINT_point2oct(group, pub, POINT_CONVERSION_COMPRESSED, out.data(), out.size(), nullptr);
  return out;
}

Bip32Key derive_child(const Bip32Key& parent, uint32_t child_index, bool hardened) {
  EC_KEY* parent_key = privkey_to_ec(parent.priv32);
  const EC_GROUP* group = EC_KEY_get0_group(parent_key);
  const uint32_t idx = hardened ? (child_index | 0x80000000u) : child_index;

  std::vector<uint8_t> data;
  if (hardened) {
    data.push_back(0);
    data.insert(data.end(), parent.priv32.begin(), parent.priv32.end());
  } else {
    const auto pub = serialize_pubkey_compressed(parent_key);
    data.insert(data.end(), pub.begin(), pub.end());
  }
  data.push_back(static_cast<uint8_t>((idx >> 24) & 0xff));
  data.push_back(static_cast<uint8_t>((idx >> 16) & 0xff));
  data.push_back(static_cast<uint8_t>((idx >> 8) & 0xff));
  data.push_back(static_cast<uint8_t>(idx & 0xff));

  unsigned int mac_len = 64;
  unsigned char mac[64];
  HMAC(EVP_sha512(), parent.chain32.data(), static_cast<int>(parent.chain32.size()), data.data(),
       data.size(), mac, &mac_len);

  BIGNUM* order = BN_new();
  EC_GROUP_get_order(group, order, nullptr);
  BIGNUM* il = BN_bin2bn(mac, 32, nullptr);
  BIGNUM* parent_priv = BN_bin2bn(parent.priv32.data(), static_cast<int>(parent.priv32.size()), nullptr);
  BIGNUM* child_bn = BN_new();
  BN_CTX* ctx = BN_CTX_new();
  if (ctx) {
    BN_mod_add(child_bn, il, parent_priv, order, ctx);
    BN_CTX_free(ctx);
  }

  std::vector<uint8_t> child_priv(32);
  BN_bn2binpad(child_bn, child_priv.data(), 32);

  Bip32Key child;
  child.priv32 = child_priv;
  child.chain32.assign(mac + 32, mac + 64);

  BN_free(order);
  BN_free(il);
  BN_free(parent_priv);
  BN_free(child_bn);
  EC_KEY_free(parent_key);
  return child;
}

Bip32Key derive_path(const Bip32Key& master, const std::vector<uint32_t>& path, const std::vector<bool>& hardened) {
  Bip32Key cur = master;
  for (size_t i = 0; i < path.size(); i++) {
    cur = derive_child(cur, path[i], hardened[i]);
  }
  return cur;
}

std::string p2pkh_address(const std::vector<uint8_t>& pubkey) {
  const auto h = hash160(pubkey);
  std::vector<uint8_t> payload;
  payload.push_back(0x00);
  payload.insert(payload.end(), h.begin(), h.end());
  return base58check_encode(payload);
}

std::string p2sh_address(const std::vector<uint8_t>& script_hash) {
  std::vector<uint8_t> payload;
  payload.push_back(0x05);
  payload.insert(payload.end(), script_hash.begin(), script_hash.end());
  return base58check_encode(payload);
}

std::string p2wpkh_address(const std::vector<uint8_t>& pubkey) {
  const auto h = hash160(pubkey);
  std::vector<uint8_t> witver = {0};
  auto data = convert_bits(h, 8, 5, true);
  witver.insert(witver.end(), data.begin(), data.end());
  return bech32_encode("bc", witver);
}

}  // namespace

std::vector<DerivationPath> build_derivation_paths(const ScanConfig& cfg) {
  std::vector<DerivationPath> paths;
  for (uint32_t acct = cfg.bip84_accounts_min; acct <= cfg.bip84_accounts_max; acct++) {
    for (uint32_t i = cfg.bip84_receive_min; i <= cfg.bip84_receive_max; i++) {
      paths.push_back({"bip84", acct, 0, i});
    }
    for (uint32_t i = cfg.bip84_change_min; i <= cfg.bip84_change_max; i++) {
      paths.push_back({"bip84", acct, 1, i});
    }
  }
  for (uint32_t acct = 0; acct <= 0; acct++) {
    for (uint32_t i = cfg.bip49_receive_min; i <= cfg.bip49_receive_max; i++) {
      paths.push_back({"bip49", acct, 0, i});
    }
  }
  for (uint32_t i = cfg.bip44_receive_min; i <= cfg.bip44_receive_max; i++) {
    paths.push_back({"bip44", 0, 0, i});
  }
  return paths;
}

std::vector<DerivedAddress> derive_addresses(const std::vector<uint8_t>& seed_entropy,
                                             const std::vector<DerivationPath>& paths) {
  std::vector<DerivedAddress> out;
  const auto seed = bip39_seed_from_entropy(seed_entropy);
  if (seed.empty()) return out;
  const Bip32Key master = bip32_master(seed);

  for (const auto& p : paths) {
    std::vector<uint32_t> path_idx;
    std::vector<bool> hardened;
    Bip32Key key;

    if (p.script_type == "bip84") {
      path_idx = {84, 0, p.account, p.branch, p.index};
      hardened = {true, true, true, false, false};
    } else if (p.script_type == "bip49") {
      path_idx = {49, 0, p.account, 0, p.index};
      hardened = {true, true, true, false, false};
    } else if (p.script_type == "bip44") {
      path_idx = {44, 0, 0, 0, p.index};
      hardened = {true, true, true, false, false};
    } else {
      continue;
    }

    key = derive_path(master, path_idx, hardened);
    EC_KEY* ec = privkey_to_ec(key.priv32);
    const auto pub = serialize_pubkey_compressed(ec);
    EC_KEY_free(ec);

    DerivedAddress d;
    d.path = p;
    d.priv32 = key.priv32;
    d.hash160 = hash160(pub);

    if (p.script_type == "bip84") {
      d.address = p2wpkh_address(pub);
    } else if (p.script_type == "bip49") {
      std::vector<uint8_t> redeem;
      redeem.push_back(0x00);
      redeem.push_back(0x14);
      redeem.insert(redeem.end(), d.hash160.begin(), d.hash160.end());
      const auto script_hash = hash160(redeem);
      d.address = p2sh_address(script_hash);
    } else {
      d.address = p2pkh_address(pub);
    }
    out.push_back(d);
  }
  return out;
}

}  // namespace scanner
