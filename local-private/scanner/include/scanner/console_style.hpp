#pragma once

#include <string>

namespace scanner {

class ConsoleStyle {
 public:
  explicit ConsoleStyle(bool enabled = true);

  void set_enabled(bool enabled);

  std::string tag_scan() const;
  std::string tag_match() const;
  std::string label(const std::string& text) const;
  std::string value(const std::string& text) const;
  std::string highlight(const std::string& text) const;
  std::string hits_value(uint64_t hits) const;
  std::string percent_value(const std::string& text) const;

  std::string abbrev(const std::string& text, int len) const;
  std::string format_duration(double seconds) const;

 private:
  bool enabled_;
};

}  // namespace scanner
