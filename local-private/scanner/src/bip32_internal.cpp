#include "scanner/bip32_internal.hpp"

#include "scanner/bip32.hpp"
#include "scanner/bip39.hpp"

#include <openssl/bn.h>
#include <openssl/crypto.h>
#include <openssl/provider.h>
#include <openssl/ec.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/obj_mac.h>

#include <cstring>
#include <vector>

namespace scanner {
namespace bip32_internal {

namespace {

void ensure_openssl() {
  static bool ready = ([]() {
    OPENSSL_init_crypto(OPENSSL_INIT_LOAD_CRYPTO_STRINGS, nullptr);
    OSSL_PROVIDER_load(nullptr, "default");
    return true;
  })();
  (void)ready;
}

const EC_GROUP* secp256k1_group() {
  ensure_openssl();
  static EC_GROUP* group = nullptr;
  if (!group) {
    group = EC_GROUP_new_by_curve_name(NID_secp256k1);
  }
  return group;
}

BIGNUM* secp256k1_order() {
  static BIGNUM* order = nullptr;
  if (!order) {
    ensure_openssl();
    static const unsigned char kOrder[] = {
        0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE,
        0xBA, 0xAE, 0xDC, 0xE6, 0xAF, 0x48, 0xA0, 0x3B, 0xBF, 0xD2, 0x5E, 0x8C, 0xD0, 0x36, 0x41, 0x41};
    order = BN_bin2bn(kOrder, sizeof(kOrder), nullptr);
  }
  return order;
}

std::vector<uint8_t> pubkey33_from_priv32(const std::vector<uint8_t>& priv32) {
  if (priv32.size() != 32) return {};
  const EC_GROUP* group = secp256k1_group();
  if (!group) return {};

  BIGNUM* priv = BN_bin2bn(priv32.data(), static_cast<int>(priv32.size()), nullptr);
  if (!priv) return {};

  EC_POINT* pub = EC_POINT_new(group);
  if (!pub) {
    BN_free(priv);
    return {};
  }

  if (EC_POINT_mul(group, pub, priv, nullptr, nullptr, nullptr) != 1) {
    EC_POINT_free(pub);
    BN_free(priv);
    return {};
  }

  std::vector<uint8_t> out(33);
  if (EC_POINT_point2oct(group, pub, POINT_CONVERSION_COMPRESSED, out.data(), out.size(), nullptr) != 33) {
    EC_POINT_free(pub);
    BN_free(priv);
    return {};
  }

  EC_POINT_free(pub);
  BN_free(priv);
  return out;
}

bool add_privkeys_mod_order(const uint8_t* a32, const uint8_t* b32, uint8_t* out32) {
  BIGNUM* order = secp256k1_order();
  BIGNUM* a = BN_bin2bn(a32, 32, nullptr);
  BIGNUM* b = BN_bin2bn(b32, 32, nullptr);
  BIGNUM* r = BN_new();
  BN_CTX* ctx = BN_CTX_new();
  if (!order || !a || !b || !r || !ctx) {
    BN_free(a);
    BN_free(b);
    BN_free(r);
    BN_CTX_free(ctx);
    return false;
  }
  const bool ok = BN_mod_add(r, a, b, order, ctx) == 1 && BN_bn2binpad(r, out32, 32) == 32;
  BN_free(a);
  BN_free(b);
  BN_free(r);
  BN_CTX_free(ctx);
  return ok;
}

Bip32Key derive_child(const Bip32Key& parent, uint32_t child_index, bool hardened) {
  if (parent.priv32.size() != 32 || parent.chain32.size() != 32) return {};

  const uint32_t idx = hardened ? (child_index | 0x80000000u) : child_index;

  std::vector<uint8_t> data;
  if (hardened) {
    data.push_back(0);
    data.insert(data.end(), parent.priv32.begin(), parent.priv32.end());
  } else {
    const auto pub = pubkey33_from_priv32(parent.priv32);
    if (pub.size() != 33) return {};
    data.insert(data.end(), pub.begin(), pub.end());
  }
  data.push_back(static_cast<uint8_t>((idx >> 24) & 0xff));
  data.push_back(static_cast<uint8_t>((idx >> 16) & 0xff));
  data.push_back(static_cast<uint8_t>((idx >> 8) & 0xff));
  data.push_back(static_cast<uint8_t>(idx & 0xff));

  unsigned int mac_len = 64;
  unsigned char mac[64];
  if (!HMAC(EVP_sha512(), parent.chain32.data(), static_cast<int>(parent.chain32.size()), data.data(), data.size(),
            mac, &mac_len) || mac_len < 64) {
    return {};
  }

  Bip32Key child;
  child.priv32.resize(32);
  if (!add_privkeys_mod_order(mac, parent.priv32.data(), child.priv32.data())) {
    return {};
  }
  child.chain32.assign(mac + 32, mac + 64);
  return child;
}

}  // namespace

Bip32Key derive_path(const Bip32Key& master, const std::vector<uint32_t>& path_idx, const std::vector<bool>& hardened) {
  ensure_openssl();
  Bip32Key cur = master;
  for (size_t i = 0; i < path_idx.size(); i++) {
    cur = derive_child(cur, path_idx[i], hardened[i]);
    if (cur.priv32.size() != 32) return {};
  }
  return cur;
}

std::vector<uint8_t> privkey_to_pubkey33(const std::vector<uint8_t>& priv32) {
  return pubkey33_from_priv32(priv32);
}

void batch_privkey_to_pubkey33(const uint8_t* privkeys, uint8_t* pubkeys33, int count) {
  for (int i = 0; i < count; i++) {
    std::vector<uint8_t> priv(privkeys + i * 32, privkeys + i * 32 + 32);
    auto pub = privkey_to_pubkey33(priv);
    if (pub.size() == 33) {
      memcpy(pubkeys33 + i * 33, pub.data(), 33);
    }
  }
}

}  // namespace bip32_internal
}  // namespace scanner
