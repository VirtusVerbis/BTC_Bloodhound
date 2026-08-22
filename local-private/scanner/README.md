# Cointrace Local Seed Scanner (Mk3 Yasmarang)

GPU forensic scanner source. **Scanner source is tracked** in the parent `cointrace` repo; **match data stays local** under `data/` (see [Git layout](#git-layout) below).


## Prerequisites (Windows + RTX 3080)



- Visual Studio 2022 Build Tools (C++17)

- CMake 3.20+

- OpenSSL (e.g. [Win64 OpenSSL](https://slproweb.com/products/Win32OpenSSL.html) or vcpkg)

- **CUDA Toolkit 12.x** (required — `scanner scan` will not run without it)

- NVIDIA driver (RTX 3080: sm_86)



## Build



```powershell

cd local-private/scanner

cmake -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_CUDA_ARCHITECTURES=86

cmake --build build --config Release

```



Set `OPENSSL_ROOT_DIR` if CMake cannot find OpenSSL. The build fails if `CUDAToolkit` is not found.



## Before scan



```powershell

cd d:\cointrace

pnpm db:pull-d1:remote

```



Create encryption key file (any secret content; SHA-256 derived to 32-byte key):



```powershell

cd local-private/scanner

mkdir data -Force

# Put secret material in data/.scanner.key (not committed)

```



## Commands



```powershell

.\build\Release\scanner.exe preflight --cointrace-db ..\..\data\cointrace.db

.\build\Release\scanner.exe verify

.\build\Release\scanner.exe benchmark --cointrace-db ..\..\data\cointrace.db

.\build\Release\scanner.exe scan --config config\scan-default.toml --key-file data\.scanner.key --cointrace-db ..\..\data\cointrace.db

.\build\Release\scanner.exe scan --gpu-util 65 --key-file data\.scanner.key --cointrace-db ..\..\data\cointrace.db

# Auto-resumes latest interrupted/running run (no --run-id needed)
.\build\Release\scanner.exe scan --config config\scan-default.toml --key-file data\.scanner.key --cointrace-db ..\..\data\cointrace.db

# Start a fresh run instead of resuming
.\build\Release\scanner.exe scan --fresh --config config\scan-default.toml --key-file data\.scanner.key --cointrace-db ..\..\data\cointrace.db

.\build\Release\scanner.exe report --summary --matches-db data\matches.db

```



## GPU pipeline (fused)



| Stage | Where |

|-------|--------|

| Yasmarang seed + BIP39 master | CPU (`masters_for_seeds` per chunk) |

| BIP32 prefix derive (steps 0–3) | **CUDA** (`prefix_derive_kernel`, 8 prefix groups per config) |

| BIP32 leaf derive (step 4 index) | **CUDA** (`leaf_pipeline_kernel`, cached parent pubkey) |

| secp256k1 pubkey | **CUDA** (`field.cu` + `secp256k1_batch.cu`) |

| hash160 + victim LUT | **CUDA** (`gpu_pipeline.cu`) |

| Address strings + DB writes | CPU (hits only) |



`preflight` probes CUDA device name and VRAM. `benchmark` reports end-to-end fused GPU checks/s.



## Resume and Ctrl-C



- **`scan` auto-resumes** the latest `running` or `interrupted` run when a checkpoint exists in `data/checkpoints/`.
- Use **`--fresh`** to start a new run instead of resuming.
- **Ctrl-C** stops within one sub-batch (~32 seeds); checkpoint is saved immediately. Re-run `scan` to continue.
- Optional **`--run-id ID`** forces a specific historical run.



## GPU load (`--gpu-util`)



`--gpu-util 10-100` scales batch size (`base_batch_seeds × util/100`) and inserts idle time between GPU batches so duty cycle tracks the requested percentage (not just CPU pacing).



## Data



| Path | Purpose |

|------|---------|

| `data/matches.db` | Encrypted seed matches (separate from cointrace) |

| `data/checkpoints/` | Resume state on Ctrl-C |

| `../../data/cointrace.db` | Read-only victim source |

## Git layout

| What | Where | Remote? |
|------|-------|---------|
| Scanner source, config, CUDA | `local-private/scanner/` (parent repo) | Yes — safe to push |
| `data/matches.db`, checkpoints | `data/` (ignored by parent; nested git repo) | No — local only |
| `data/.scanner.key` | `data/` | **Never** — excluded from both repos |

`data/` has its own `git init` for optional local versioning of match history. See `data/README.md`. `.scanner.key` is gitignored everywhere.

## Scope

Mk3 cold-start Yasmarang path, zero RTC, no dice, no passphrases. Standard BIP84/49/44 paths from `config/scan-default.toml`.

