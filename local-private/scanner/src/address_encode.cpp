#include "scanner/address_encode.hpp"
#include "scanner/batch_derive.hpp"

#include <array>
#include <cstring>
#include <openssl/evp.h>
#include <openssl/sha.h>
#include <vector>

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

}  // namespace

std::string encode_address(ScriptFamily family, const uint8_t* pubkey33, const uint8_t* pubkey_hash20) {
  std::vector<uint8_t> pub(pubkey33, pubkey33 + 33);
  std::vector<uint8_t> h(pubkey_hash20, pubkey_hash20 + 20);
  if (family == ScriptFamily::Bip84) {
    std::vector<uint8_t> witver = {0};
    auto data = convert_bits(h, 8, 5, true);
    witver.insert(witver.end(), data.begin(), data.end());
    return bech32_encode("bc", witver);
  }
  if (family == ScriptFamily::Bip49) {
    std::vector<uint8_t> redeem = {0x00, 0x14};
    redeem.insert(redeem.end(), h.begin(), h.end());
    unsigned char sha[32];
    SHA256(redeem.data(), redeem.size(), sha);
    unsigned char rh[20];
    EVP_MD_CTX* ctx = EVP_MD_CTX_new();
    EVP_DigestInit_ex(ctx, EVP_ripemd160(), nullptr);
    EVP_DigestUpdate(ctx, sha, 32);
    unsigned int rl = 20;
    EVP_DigestFinal_ex(ctx, rh, &rl);
    EVP_MD_CTX_free(ctx);
    std::vector<uint8_t> payload = {0x05};
    payload.insert(payload.end(), rh, rh + 20);
    return base58check_encode(payload);
  }
  std::vector<uint8_t> payload = {0x00};
  payload.insert(payload.end(), h.begin(), h.end());
  return base58check_encode(payload);
}

std::string encode_address_for_path(const DerivationPath& path, const uint8_t* pubkey33,
                                    const uint8_t* pubkey_hash20) {
  return encode_address(script_family_from_path(path), pubkey33, pubkey_hash20);
}

}  // namespace scanner
