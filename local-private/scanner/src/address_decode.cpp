#include "scanner/victim_loader.hpp"

#include <openssl/sha.h>

#include <array>
#include <cctype>
#include <cstring>
#include <vector>

namespace scanner {

namespace {

const char* BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

int base58_index(char c) {
  const char* p = strchr(BASE58_ALPHABET, c);
  return p ? static_cast<int>(p - BASE58_ALPHABET) : -1;
}

bool base58_decode(const std::string& input, std::vector<uint8_t>& out) {
  out.assign(1, 0);
  for (char ch : input) {
    const int carry = base58_index(ch);
    if (carry < 0) return false;
    int acc = carry;
    for (size_t i = 0; i < out.size(); i++) {
      acc += static_cast<int>(out[i]) * 58;
      out[i] = static_cast<uint8_t>(acc & 0xff);
      acc >>= 8;
    }
    while (acc > 0) {
      out.push_back(static_cast<uint8_t>(acc & 0xff));
      acc >>= 8;
    }
  }
  size_t zeros = 0;
  while (zeros < input.size() && input[zeros] == BASE58_ALPHABET[0]) zeros++;
  std::vector<uint8_t> decoded(zeros, 0);
  for (auto it = out.rbegin(); it != out.rend(); ++it) decoded.push_back(*it);
  out.swap(decoded);
  return true;
}

bool base58check_decode(const std::string& input, std::vector<uint8_t>& payload_out) {
  std::vector<uint8_t> raw;
  if (!base58_decode(input, raw) || raw.size() < 5) return false;
  unsigned char hash1[SHA256_DIGEST_LENGTH];
  unsigned char hash2[SHA256_DIGEST_LENGTH];
  SHA256(raw.data(), raw.size() - 4, hash1);
  SHA256(hash1, SHA256_DIGEST_LENGTH, hash2);
  if (memcmp(raw.data() + raw.size() - 4, hash2, 4) != 0) return false;
  payload_out.assign(raw.begin(), raw.end() - 4);
  return true;
}

const std::array<char, 32> BECH32_CHARSET = {
    'q', 'p', 'z', 'r', 'y', '9', 'x', '8', 'g', 'f', '2', 't', 'v', 'd', 'w', '0', 's', '3', 'j', 'n',
    '5', '4', 'k', 'h', 'c', 'e', '6', 'm', 'u', 'a', '7', 'l'};

int bech32_charset_index(char c) {
  c = static_cast<char>(tolower(static_cast<unsigned char>(c)));
  for (int i = 0; i < 32; i++) {
    if (BECH32_CHARSET[i] == c) return i;
  }
  return -1;
}

uint32_t bech32_polymod(const std::vector<uint8_t>& values) {
  static const uint32_t GEN[] = {0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3};
  uint32_t chk = 1;
  for (uint8_t value : values) {
    const uint32_t top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ static_cast<uint32_t>(value);
    for (int i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk;
}

bool bech32_decode(const std::string& addr, std::string& hrp_out, std::vector<uint8_t>& data_out) {
  const size_t pos = addr.rfind('1');
  if (pos == std::string::npos || pos + 7 > addr.size()) return false;
  hrp_out = addr.substr(0, pos);
  std::vector<uint8_t> data;
  for (size_t i = pos + 1; i < addr.size(); i++) {
    const int v = bech32_charset_index(addr[i]);
    if (v < 0) return false;
    data.push_back(static_cast<uint8_t>(v));
  }
  if (data.size() < 6) return false;
  std::vector<uint8_t> values;
  for (char c : hrp_out) values.push_back(static_cast<uint8_t>(c >> 5));
  values.push_back(0);
  for (char c : hrp_out) values.push_back(static_cast<uint8_t>(c & 31));
  values.insert(values.end(), data.begin(), data.end());
  const uint32_t mod = bech32_polymod(values);
  if (mod != 1) return false;
  data.resize(data.size() - 6);
  data_out = data;
  return true;
}

std::vector<uint8_t> convert_bits(const std::vector<uint8_t>& in, int frombits, int tobits, bool pad) {
  std::vector<uint8_t> out;
  uint32_t acc = 0;
  int bits = 0;
  const uint32_t maxv = (1u << tobits) - 1;
  for (uint8_t value : in) {
    if (value >> frombits) return {};
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

}  // namespace

bool address_to_lookup_key(const std::string& address, VictimLookupKey& out) {
  out.key20.clear();
  if (address.rfind("bc1", 0) == 0) {
    std::string hrp;
    std::vector<uint8_t> data;
    if (!bech32_decode(address, hrp, data)) return false;
    if (hrp != "bc" || data.empty() || data[0] != 0) return false;
    std::vector<uint8_t> payload(data.begin() + 1, data.end());
    const auto bytes = convert_bits(payload, 5, 8, false);
    if (bytes.empty() || bytes.size() != 20) return false;
    out.key20 = bytes;
    out.family = ScriptFamily::Bip84;
    return true;
  }
  std::vector<uint8_t> payload;
  if (!base58check_decode(address, payload) || payload.size() != 21) return false;
  out.key20.assign(payload.begin() + 1, payload.end());
  if (payload[0] == 0x00) {
    out.family = ScriptFamily::Bip44;
    return true;
  }
  if (payload[0] == 0x05) {
    out.family = ScriptFamily::Bip49;
    return true;
  }
  return false;
}

bool address_to_hash160(const std::string& address, std::vector<uint8_t>& hash160_out) {
  VictimLookupKey key;
  if (!address_to_lookup_key(address, key)) return false;
  hash160_out = key.key20;
  return true;
}

}  // namespace scanner
