#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace scanner {

class AesGcmCipher {
 public:
  bool load_key_file(const std::string& path, std::string& error);
  bool load_key_bytes(const std::vector<uint8_t>& key32);

  bool encrypt(const std::vector<uint8_t>& plain, std::vector<uint8_t>& out_blob, std::string& error) const;
  bool decrypt(const std::vector<uint8_t>& blob, std::vector<uint8_t>& plain, std::string& error) const;

 private:
  std::vector<uint8_t> key_;
};

std::string sha256_hex(const std::vector<uint8_t>& data);
std::string sha256_hex(const std::string& data);

}  // namespace scanner
