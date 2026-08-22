#include "scanner/crypto_aes.hpp"

#include <openssl/evp.h>
#include <openssl/rand.h>
#include <openssl/sha.h>

#include <fstream>
#include <iomanip>
#include <sstream>

namespace scanner {

bool AesGcmCipher::load_key_file(const std::string& path, std::string& error) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    error = "cannot open key file: " + path;
    return false;
  }
  std::vector<uint8_t> data((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  if (data.size() < 32) {
  // Derive 32-byte key from file contents via SHA-256
    std::vector<uint8_t> hash(32);
    SHA256(data.data(), data.size(), hash.data());
    key_ = hash;
    return true;
  }
  key_.assign(data.begin(), data.begin() + 32);
  return true;
}

bool AesGcmCipher::load_key_bytes(const std::vector<uint8_t>& key32) {
  if (key32.size() != 32) return false;
  key_ = key32;
  return true;
}

bool AesGcmCipher::encrypt(const std::vector<uint8_t>& plain, std::vector<uint8_t>& out_blob, std::string& error) const {
  if (key_.size() != 32) {
    error = "encryption key not loaded";
    return false;
  }
  std::vector<uint8_t> iv(12);
  if (RAND_bytes(iv.data(), 12) != 1) {
    error = "RAND_bytes failed";
    return false;
  }
  std::vector<uint8_t> tag(16);
  std::vector<uint8_t> cipher(plain.size());

  EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
  if (!ctx) {
    error = "EVP_CIPHER_CTX_new failed";
    return false;
  }
  int ok = 1;
  int len = 0;
  ok &= EVP_EncryptInit_ex(ctx, EVP_aes_256_gcm(), nullptr, key_.data(), iv.data());
  ok &= EVP_EncryptUpdate(ctx, cipher.data(), &len, plain.data(), static_cast<int>(plain.size()));
  int cipher_len = len;
  ok &= EVP_EncryptFinal_ex(ctx, cipher.data() + len, &len);
  cipher_len += len;
  ok &= EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, 16, tag.data());
  EVP_CIPHER_CTX_free(ctx);
  if (!ok) {
    error = "AES-GCM encrypt failed";
    return false;
  }
  cipher.resize(cipher_len);
  out_blob.clear();
  out_blob.insert(out_blob.end(), iv.begin(), iv.end());
  out_blob.insert(out_blob.end(), tag.begin(), tag.end());
  out_blob.insert(out_blob.end(), cipher.begin(), cipher.end());
  return true;
}

bool AesGcmCipher::decrypt(const std::vector<uint8_t>& blob, std::vector<uint8_t>& plain, std::string& error) const {
  if (key_.size() != 32) {
    error = "encryption key not loaded";
    return false;
  }
  if (blob.size() < 28) {
    error = "encrypted blob too short";
    return false;
  }
  const uint8_t* iv = blob.data();
  const uint8_t* tag = blob.data() + 12;
  const uint8_t* cipher = blob.data() + 28;
  const size_t cipher_len = blob.size() - 28;

  plain.assign(cipher_len, 0);
  EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
  if (!ctx) {
    error = "EVP_CIPHER_CTX_new failed";
    return false;
  }
  int ok = 1;
  int len = 0;
  ok &= EVP_DecryptInit_ex(ctx, EVP_aes_256_gcm(), nullptr, key_.data(), iv);
  ok &= EVP_DecryptUpdate(ctx, plain.data(), &len, cipher, static_cast<int>(cipher_len));
  int plain_len = len;
  ok &= EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_TAG, 16, const_cast<uint8_t*>(tag));
  ok &= EVP_DecryptFinal_ex(ctx, plain.data() + len, &len);
  plain_len += len;
  EVP_CIPHER_CTX_free(ctx);
  if (!ok) {
    error = "AES-GCM decrypt failed";
    return false;
  }
  plain.resize(plain_len);
  return true;
}

std::string sha256_hex(const std::vector<uint8_t>& data) {
  unsigned char hash[SHA256_DIGEST_LENGTH];
  SHA256(data.data(), data.size(), hash);
  std::ostringstream oss;
  for (int i = 0; i < SHA256_DIGEST_LENGTH; i++) {
    oss << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(hash[i]);
  }
  return oss.str();
}

std::string sha256_hex(const std::string& data) {
  return sha256_hex(std::vector<uint8_t>(data.begin(), data.end()));
}

std::vector<uint8_t> sha256d(const uint8_t* data, size_t len) {
  unsigned char h1[SHA256_DIGEST_LENGTH];
  unsigned char h2[SHA256_DIGEST_LENGTH];
  SHA256(data, len, h1);
  SHA256(h1, SHA256_DIGEST_LENGTH, h2);
  return std::vector<uint8_t>(h2, h2 + SHA256_DIGEST_LENGTH);
}

std::vector<uint8_t> sha256d(const std::vector<uint8_t>& data) {
  return sha256d(data.data(), data.size());
}

}  // namespace scanner
