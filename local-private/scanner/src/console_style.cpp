#include "scanner/console_style.hpp"

#include <chrono>
#include <sstream>

namespace scanner {

ConsoleStyle::ConsoleStyle(bool enabled) : enabled_(enabled) {}

void ConsoleStyle::set_enabled(bool enabled) { enabled_ = enabled; }

std::string ConsoleStyle::tag_scan() const {
  if (!enabled_) return "[scan]";
  return "\033[36m[scan]\033[0m";
}

std::string ConsoleStyle::tag_match() const {
  if (!enabled_) return "[MATCH]";
  return "\033[92m[MATCH]\033[0m";
}

std::string ConsoleStyle::label(const std::string& text) const {
  if (!enabled_) return text;
  return "\033[97m" + text + "\033[0m";
}

std::string ConsoleStyle::value(const std::string& text) const {
  if (!enabled_) return text;
  return "\033[90m" + text + "\033[0m";
}

std::string ConsoleStyle::highlight(const std::string& text) const {
  if (!enabled_) return text;
  return "\033[93m" + text + "\033[0m";
}

std::string ConsoleStyle::hits_value(uint64_t hits) const {
  if (!enabled_ || hits == 0) return std::to_string(hits);
  return "\033[92m" + std::to_string(hits) + "\033[0m";
}

std::string ConsoleStyle::percent_value(const std::string& text) const {
  if (!enabled_) return text;
  return "\033[93m" + text + "\033[0m";
}

std::string ConsoleStyle::abbrev(const std::string& text, int len) const {
  if (static_cast<int>(text.size()) <= len * 2 + 1) return text;
  return text.substr(0, len) + "…" + text.substr(text.size() - len);
}

std::string ConsoleStyle::format_duration(double seconds) const {
  const int total = static_cast<int>(seconds);
  const int h = total / 3600;
  const int m = (total % 3600) / 60;
  const int s = total % 60;
  std::ostringstream oss;
  if (h > 0) oss << h << "h ";
  oss << m << "m " << s << "s";
  return oss.str();
}

}  // namespace scanner
