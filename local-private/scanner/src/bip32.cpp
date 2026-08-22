#include "scanner/bip32.hpp"

#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/sha.h>

#include <vector>

namespace scanner {

static std::vector<uint8_t> hmac_sha512(const std::vector<uint8_t>& key, const std::vector<uint8_t>& data) {
  unsigned int len = 64;
  std::vector<uint8_t> out(64);
  HMAC(EVP_sha512(), key.data(), static_cast<int>(key.size()), data.data(), data.size(), out.data(), &len);
  out.resize(len);
  return out;
}

std::vector<uint8_t> hash160(const std::vector<uint8_t>& data) {
  unsigned char sha[SHA256_DIGEST_LENGTH];
  SHA256(data.data(), data.size(), sha);
  unsigned char ripe[20];
  EVP_MD_CTX* ctx = EVP_MD_CTX_new();
  EVP_DigestInit_ex(ctx, EVP_ripemd160(), nullptr);
  EVP_DigestUpdate(ctx, sha, SHA256_DIGEST_LENGTH);
  unsigned int ripe_len = 20;
  EVP_DigestFinal_ex(ctx, ripe, &ripe_len);
  EVP_MD_CTX_free(ctx);
  return std::vector<uint8_t>(ripe, ripe + 20);
}

Bip32Key bip32_master(const std::vector<uint8_t>& seed) {
  const std::vector<uint8_t> key = {'B', 'i', 't', 'c', 'o', 'i', 'n', ' ', 's', 'e', 'e', 'd'};
  const auto I = hmac_sha512(key, seed);
  Bip32Key k;
  k.priv32.assign(I.begin(), I.begin() + 32);
  k.chain32.assign(I.begin() + 32, I.end());
  return k;
}

Bip32Key bip32_child(const Bip32Key& parent, uint32_t child_index, bool hardened) {
  (void)parent;
  (void)child_index;
  (void)hardened;
  return {};
}

}  // namespace scanner
