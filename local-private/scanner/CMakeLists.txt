cmake_minimum_required(VERSION 3.20)

project(cointrace_scanner LANGUAGES CXX C CUDA)



set(CMAKE_CXX_STANDARD 17)

set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(CMAKE_CUDA_STANDARD 17)

set(CMAKE_CUDA_STANDARD_REQUIRED ON)



option(SCANNER_ENABLE_CUDA "Build CUDA GPU scanner (required for scan)" ON)



find_package(OpenSSL REQUIRED)



if(NOT SCANNER_ENABLE_CUDA)

  message(FATAL_ERROR "SCANNER_ENABLE_CUDA=OFF is not supported — scanner scan requires CUDA")

endif()



enable_language(CUDA)

find_package(CUDAToolkit REQUIRED)



if(NOT DEFINED CMAKE_CUDA_ARCHITECTURES OR CMAKE_CUDA_ARCHITECTURES STREQUAL "")

  set(CMAKE_CUDA_ARCHITECTURES 86)

endif()



set(SCANNER_SOURCES

  src/main.cpp

  src/yasmarang.cpp

  src/coldcard_seed.cpp

  src/pad_enumerator.cpp

  src/victim_loader.cpp

  src/address_decode.cpp

  src/match_db.cpp

  src/crypto_aes.cpp

  src/bip39.cpp

  src/bip32.cpp

  src/bip32_internal.cpp

  src/bitcoin_derive.cpp

  src/batch_derive.cpp

  src/address_encode.cpp

  src/gpu_engine.cpp

  src/orchestrator.cpp

  src/console_style.cpp

  src/config.cpp

  src/checkpoint.cpp

  src/report.cpp

  third_party/sqlite3/sqlite3.c

  cuda/gpu_pipeline.cu

  cuda/hash160_batch.cu

  cuda/field.cu

  cuda/secp256k1_batch.cu

)



add_executable(scanner ${SCANNER_SOURCES})



target_include_directories(scanner PRIVATE

  ${CMAKE_CURRENT_SOURCE_DIR}/include

  ${CMAKE_CURRENT_SOURCE_DIR}

  ${CMAKE_CURRENT_SOURCE_DIR}/third_party/sqlite3

)



target_compile_definitions(scanner PRIVATE SCANNER_HAS_CUDA=1)



target_link_libraries(scanner PRIVATE OpenSSL::SSL OpenSSL::Crypto CUDA::cudart)



set_target_properties(scanner PROPERTIES CUDA_SEPARABLE_COMPILATION ON)



if(MSVC)
  target_compile_options(scanner PRIVATE
    $<$<COMPILE_LANGUAGE:CXX>:/W4 /utf-8>
    $<$<COMPILE_LANGUAGE:C>:/W4 /utf-8>
  )
else()

  target_compile_options(scanner PRIVATE -Wall -Wextra -O3)

endif()



install(TARGETS scanner RUNTIME DESTINATION bin)

