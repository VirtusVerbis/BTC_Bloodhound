#pragma once

#include <string>

#include "scanner/types.hpp"

namespace scanner {

bool load_scan_config(const std::string& path, ScanConfig& cfg, std::string& error);

}  // namespace scanner
