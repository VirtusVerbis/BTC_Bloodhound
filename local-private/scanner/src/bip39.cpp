#include "scanner/bip39.hpp"

#include <openssl/evp.h>
#include <openssl/sha.h>

#include <fstream>
#include <sstream>
#include <vector>

namespace scanner {

static std::vector<std::string> load_wordlist() {
  std::vector<std::string> words;
  std::ifstream in("config/bip39_english.txt");
  if (!in) in.open("../config/bip39_english.txt");
  std::string w;
  while (std::getline(in, w)) {
    if (!w.empty() && w.back() == '\r') w.pop_back();
    if (!w.empty()) words.push_back(w);
  }
  return words;
}

std::string entropy_to_mnemonic(const std::vector<uint8_t>& entropy) {
  const auto words = load_wordlist();
  if (words.size() != 2048 || entropy.size() != 32) return "";

  unsigned char hash[SHA256_DIGEST_LENGTH];
  SHA256(entropy.data(), entropy.size(), hash);

  std::vector<uint8_t> bits;
  for (uint8_t b : entropy) {
    for (int i = 7; i >= 0; i--) bits.push_back((b >> i) & 1);
  }
  for (int i = 0; i < 8; i++) bits.push_back((hash[0] >> (7 - i)) & 1);

  std::string mnemonic;
  for (size_t i = 0; i + 11 <= bits.size(); i += 11) {
    uint32_t idx = 0;
    for (int j = 0; j < 11; j++) idx = (idx << 1) | bits[i + j];
    if (!mnemonic.empty()) mnemonic += ' ';
    mnemonic += words[idx];
  }
  return mnemonic;
}

std::vector<uint8_t> bip39_seed_from_entropy(const std::vector<uint8_t>& entropy) {
  const std::string mnemonic = entropy_to_mnemonic(entropy);
  if (mnemonic.empty()) return {};

  const std::string salt = "mnemonic";
  std::vector<uint8_t> out(64);
  if (PKCS5_PBKDF2_HMAC(mnemonic.c_str(), static_cast<int>(mnemonic.size()),
                        reinterpret_cast<const unsigned char*>(salt.data()),
                        static_cast<int>(salt.size()), 2048, EVP_sha512(), 64, out.data()) != 1) {
    return {};
  }
  return out;
}

}  // namespace scanner
