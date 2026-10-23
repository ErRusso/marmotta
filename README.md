# Marmotta

<p align="center">
  <img src="https://raw.githubusercontent.com/napi-bindings/marmotta/main/marmotta.jpg" alt="Marmotta, the native addon build tool" width="384">
</p>

<div align="center">

[![CI](https://github.com/napi-bindings/marmotta/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/napi-bindings/marmotta/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/napi-bindings/marmotta)](https://github.com/napi-bindings/marmotta/releases/latest)
[![marmotta monthly downloads on npm](https://img.shields.io/npm/dm/marmotta?label=marmotta%20downloads)](https://www.npmjs.com/package/marmotta)
[![@napi-bindings/marmotta monthly downloads on npm](https://img.shields.io/npm/dm/%40napi-bindings%2Fmarmotta?label=%40napi-bindings%2Fmarmotta%20downloads)](https://www.npmjs.com/package/@napi-bindings/marmotta)

</div>

Marmotta builds Node.js native addons written in C or C++ with [Node-API](https://nodejs.org/api/n-api.html). It uses [Zig](https://ziglang.org/) as the compiler toolchain and can install Zig for you, so projects do not need to configure `node-gyp` or CMake.

## Contents

- [Highlights](#highlights)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Command-line reference](#command-line-reference)
- [Zig toolchain](#zig-toolchain)
- [Contributing](#contributing)
- [License](#license)
- [Team](#team)
- [Contributors](#contributors)

## Highlights

- Build C and C++ Node-API addons into `.node` files.
- Use the Node-API headers supplied by Marmotta; no separate Node header installation is needed.
- Reuse node-gyp-oriented sources that use `NODE_GYP_MODULE_NAME`.
- Build for the host platform or pass a Zig target triple for cross-compilation.
- Install Zig automatically when a suitable compiler is not already on `PATH`.
- Use a Zig installation that already exists on the system with `MARMOTTA_ZIG_DIR`, for example where downloads are blocked.
- Load the same addon in Node.js, Electron, Deno, and Bun. On Windows, Marmotta binds Node-API functions to the process that loads the addon instead of to `node.exe`, so no delay-load hook is needed.

## Requirements

- Node.js 20 or later and npm. To run Marmotta without Node.js, use a [standalone binary](#standalone-binary) instead.
- A C or C++ Node-API addon source file (`.c`, `.cc`, `.cpp`, or `.cxx`).
- `tar` and internet access when Marmotta needs to download Zig.

Automatic Zig downloads are supported on x64 and ARM64 Linux, macOS, and Windows hosts. On other host platforms, install Zig separately and make it available on `PATH`.

## Installation

Install the unscoped package globally:

```sh
npm install --global marmotta
marmotta --help
```

Or add Marmotta to a project and run it with `npx`:

```sh
npm install --save-dev marmotta
npx marmotta --help
```

The same CLI is also published as `@napi-bindings/marmotta`. To install that package instead:

```sh
npm install --save-dev @napi-bindings/marmotta
npx marmotta --help
```

### Standalone binary

Every release ships a self-contained executable per platform. It embeds the CLI and the
Node-API headers, so Node.js and npm are not required to run it; Zig is still downloaded
on first use, exactly as with the npm package.

1. Download the file for your platform from the
   [GitHub releases page](https://github.com/napi-bindings/marmotta/releases), for
   example `marmotta-v0.6.0-linux-x64`.
2. Make it executable and put it on your `PATH`:

   ```sh
   chmod +x marmotta-v0.6.0-linux-x64
   sudo mv marmotta-v0.6.0-linux-x64 /usr/local/bin/marmotta
   marmotta --version
   ```

   On Windows, rename the file to `marmotta.exe` and place it in a directory on `PATH`.

| File | Platform |
| --- | --- |
| `marmotta-vX.Y.Z-linux-x64` | Linux x64 (glibc) |
| `marmotta-vX.Y.Z-linux-arm64` | Linux ARM64 (glibc) |
| `marmotta-vX.Y.Z-linux-x64-musl` | Linux x64 (musl, e.g. Alpine) |
| `marmotta-vX.Y.Z-linux-arm64-musl` | Linux ARM64 (musl, e.g. Alpine) |
| `marmotta-vX.Y.Z-darwin-x64` | macOS, Intel |
| `marmotta-vX.Y.Z-darwin-arm64` | macOS, Apple silicon |
| `marmotta-vX.Y.Z-windows-x64.exe` | Windows x64 |
| `marmotta-vX.Y.Z-windows-arm64.exe` | Windows ARM64 |

Each release includes a `SHA256SUMS` file and GitHub build provenance attestations, so
a download can be checked with `sha256sum --check --ignore-missing SHA256SUMS` and
`gh attestation verify`.

Notes on the standalone binaries:

- They behave like the npm package: `NODE_OPTIONS` does not affect them, and a stray
  `.env` or `bunfig.toml` in the project directory does not change what they do.
  Like any Bun program, they do honor `BUN_OPTIONS`.
- The macOS binaries carry an ad-hoc signature with the hardened runtime enabled and
  the JIT entitlements JavaScriptCore needs; they are not notarized. If macOS blocks a
  downloaded binary, remove the quarantine attribute with
  `xattr -d com.apple.quarantine <file>` (or control-click and open it).
- The musl binaries link against `libstdc++`, which a stock Alpine image does not ship.
  Install it first: `apk add libstdc++`.
- The binaries are built with [`bun build --compile`](https://bun.com/docs/bundler/executables).

## Quick start

Create a Node.js project with a C or C++ Node-API source file. For example, save this as `src/hello.c`:

```c
#include <assert.h>
#include <node_api.h>

static napi_value Hello(napi_env env, napi_callback_info info) {
  napi_value result;
  napi_status status = napi_create_string_utf8(env, "world", 5, &result);
  assert(status == napi_ok);
  return result;
}

static napi_value Initialize(napi_env env, napi_value exports) {
  napi_property_descriptor descriptor = {
    "hello", 0, Hello, 0, 0, 0, napi_default, 0
  };
  napi_status status = napi_define_properties(env, exports, 1, &descriptor);
  assert(status == napi_ok);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
```

Create `marmotta.config.json` in the project root:

```json
{
  "name": "hello",
  "sources": ["src/hello.c"],
  "outputDir": "build"
}
```

Build and load the addon:

```sh
npx marmotta build
node -e "console.log(require('./build/hello.node').hello())"
```

The example prints `world`. `configure` can be run to validate the project and prepare Zig before building, but it is optional; `build` loads the configuration and ensures the toolchain itself.

## Configuration

All paths in either configuration file are resolved relative to the project directory. The configuration file is optional. Without it, Marmotta uses the package or directory name, discovers source files, and places the addon in the project root.

You can use `marmotta.config.js` to compute configuration values with JavaScript. If both config files are present, `marmotta.config.js` takes precedence over `marmotta.config.json`. Export either a configuration object as the default export or a function that returns one; the function may be asynchronous and receives the project directory, requested Zig target, and host platform and architecture:

```js
export default ({ target, platform }) => {
  const isWindows = target ? target.includes('windows') : platform === 'win32';
  return {
    name: 'hello',
    sources: ['src/hello.c'],
    cFlags: isWindows ? ['-DWIN32_BUILD'] : [],
  };
};
```

For `.js` files, use the module format selected by your project's `package.json` (`"type": "module"` for ESM). JavaScript configuration files execute as project code.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | string | `package.json` name, or project directory name | Addon name, also used in the output filename `<name>.node`. Characters other than letters, digits, `_`, and `-` are replaced with `_`. |
| `sources` | string array | discovered source files | C/C++ sources to compile. An empty or omitted array enables recursive discovery. |
| `includeDirs` | string array | `[]` | Additional header search directories. |
| `cFlags` | string array | `[]` | Additional compiler flags for C sources. |
| `cxxFlags` | string array | `[]` | Additional compiler flags for C++ sources. |
| `linkerFlags` | string array | `[]` | Additional linker flags. |
| `outputDir` | string | `.` | Output directory. The generated addon is `<outputDir>/<name>.node`. |
| `zigVersion` | string | Zig from `PATH`, else local/latest stable | Pin an exact stable Zig version, for example `0.14.1`. When set, Marmotta uses or downloads this managed version instead of using Zig from `PATH`. Ignored when `MARMOTTA_ZIG_DIR` is set. |

Each array field must contain only strings. During source discovery Marmotta ignores `.git`, `.marmotta`, `build`, `dist`, and `node_modules`. Explicit source and include paths must be relative to the project directory or absolute paths; each source must exist and be a file.

Marmotta defines `NODE_GYP_MODULE_NAME` for every source file using the configured addon name. Characters that cannot appear in a C identifier are replaced with `_`, and a leading digit is prefixed with `_`. This allows compatible sources to use `NODE_API_MODULE(NODE_GYP_MODULE_NAME, Initialize)` without changing the macro.

## Command-line reference

Run `marmotta --help` or `npx marmotta --help` for the built-in usage summary.

### Commands

| Command | Description |
| --- | --- |
| `marmotta configure` | Validate the project configuration and ensure Zig is available. |
| `marmotta build` | Compile the configured or discovered C/C++ sources into a `.node` addon. |
| `marmotta rebuild` | Remove the selected generated addon and build it again. |
| `marmotta clean` | Remove the generated addon file only. Zig and other build files are left untouched. |
| `marmotta install` | Ensure a Zig compiler is available, downloading one if needed. |
| `marmotta list` | List Zig versions managed by Marmotta. |
| `marmotta remove <version>` | Remove a managed Zig version, for example `marmotta remove 0.14.1`. |

### Options

| Option | Commands | Description |
| --- | --- | --- |
| `-C, --directory <path>` | `configure`, `build`, `rebuild`, `clean` | Project directory. Defaults to the current working directory. |
| `-o, --output-dir <path>` | `build`, `rebuild`, `clean` | Override `outputDir`. Relative paths are resolved from the project directory. |
| `--target <triple>` | `build`, `rebuild` | Zig target triple used for cross-compilation. |
| `--debug` | `build`, `rebuild` | Compile without optimization and include debug information (`-O0 -g` instead of `-O2`). |
| `--json` | Any command | Emit machine-readable JSON Lines instead of plain text. Recognized before or after the command. |
| `-h, --help` | Any command | Show help. |
| `-v, --version` | Top-level command | Show the Marmotta version. |

For example, request a build for ARM64 macOS:

```sh
npx marmotta build --target aarch64-macos
```

Use `--json` in CI when another process needs to consume Marmotta's output; see [Logging](#logging) for the record format and the `MARMOTTA_LOG` variable.

Use a target triple supported by Zig for the intended target. Cross-compilation does not run the resulting addon on the host; load it on a compatible target system.

### Logging

By default Marmotta writes plain text: command results on stdout and errors on stderr, with no level prefixes, so scripts that read `marmotta --version` or `marmotta list` keep working unchanged.

Pass `--json` when another process needs to consume the output, as in CI. The flag is recognized before or after the command, and each record is one JSON object on its own line (JSON Lines):

```sh
npx marmotta build --json
npx marmotta --json list
```

```json
{"level":"info","time":1730000000000,"message":"Addon built: /project/build/hello.node"}
{"level":"info","time":1730000000001,"data":{"versions":["0.13.0","0.14.0"]},"message":"Installed Zig versions"}
{"level":"error","time":1730000000002,"data":{"code":"CLI_ARGUMENT_ERROR","exitCode":2},"message":"Unknown option: --bogus"}
```

- `level` is a string such as `info`, `warn`, or `error`. Informational records go to stdout; warnings and errors go to stderr.
- `message` is the human-readable text, and `data` carries the record's structured context when there is any, such as the error `code` and `exitCode`, the installed `versions`, or a child process's `command` and `stream`.
- Command results, such as help, the version, `list`, confirmations and error messages, are always printed. Output from the Zig and `tar` child processes is captured and re-emitted as records tagged with `command` and `stream`, so every line printed in `--json` mode is valid JSON and compiler errors are never hidden. Lines from the child's stderr are `warn` records on stderr; lines from its stdout are `info` records on stdout. Lines keep their order within each stream, but the order between a child's stdout and stderr lines is not preserved.
- Set `MARMOTTA_LOG` to the minimum level for diagnostic records: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, or `silent`. The default is `info`, which hides `debug` records: which Zig is used, where Zig is downloaded from, and each Zig or `tar` command line. An unrecognized value is ignored with a warning.

`MARMOTTA_LOG` filters diagnostics only; it never hides a command's result or its final error. It applies to both formats and does not change the shape of the output.

`--version` is a top-level request and cannot be combined with a command, so `marmotta build --version` fails with an argument error instead of printing the version and skipping the build.


## Zig toolchain

Without a `zigVersion` pin, Marmotta uses `zig` from `PATH` when available, then a locally managed version, and otherwise downloads the latest stable Zig release for the supported host platform into the Marmotta home directory (see [Marmotta home directory](#marmotta-home-directory)). If `zigVersion` is set, Marmotta ignores `PATH` and selects that exact managed version, downloading it if necessary. If the pinned version is not available for the host platform, the command fails instead of falling back to another version. If the download index includes a checksum, Marmotta verifies the downloaded archive. If `MARMOTTA_ZIG_DIR` is set, Marmotta uses only that Zig and never downloads one (see [Existing Zig installation](#existing-zig-installation)).

Prepare Zig in advance:

```sh
npx marmotta install
```

List and remove toolchain versions managed by Marmotta:

```sh
npx marmotta list
npx marmotta remove 0.6.0
```

`list` and `remove` operate only on versions managed by Marmotta; they do not list, uninstall, or modify a system Zig executable found on `PATH`.

### Existing Zig installation

Set `MARMOTTA_ZIG_DIR` to the directory of a Zig installation that already exists on the system, for example when downloads are blocked or the toolchain is provided by the organization and cannot be changed:

```sh
export MARMOTTA_ZIG_DIR=/opt/zig-x86_64-linux-0.14.1
npx marmotta build
```

- The directory must contain the Zig executable (`zig`, or `zig.exe` on Windows), as in the archives published on ziglang.org.
- Marmotta uses this Zig for every command and never downloads Zig while the variable is set. It takes precedence over Zig on `PATH` and over the versions managed by Marmotta, and a `zigVersion` pin in the configuration is ignored.
- If the directory does not contain a Zig executable that can be run, the command fails with `MARMOTTA_ZIG_DIR_UNAVAILABLE` and names the expected path. Marmotta does not fall back to another Zig.
- The value follows the same rules as `MARMOTTA_HOME`: it must be an absolute path without leading or trailing whitespace, otherwise it is rejected with `MARMOTTA_ZIG_DIR_INVALID`. An empty value is treated as unset.
- Marmotta never writes to this directory, and `list` and `remove` do not include or change it. Temporary build files still go to the Marmotta home directory, and Zig's global cache follows the rules described there.

### Marmotta home directory

Marmotta stores managed Zig toolchains (`toolchains/zig/<version>`) and temporary build files in its home directory. By default this is `.marmotta` in the user's home directory (`~/.marmotta` on Unix-like systems or `%USERPROFILE%\.marmotta` on Windows).

Set `MARMOTTA_HOME` to use another directory, for example when the home directory is read-only or not persistent, as on restricted CI runners or in containers:

```sh
export MARMOTTA_HOME=/var/cache/marmotta
npx marmotta build
```

- The value must be an absolute path. On Windows it must start with a drive letter (`D:\marmotta`) or be a UNC path (`\\server\share\marmotta`); root-relative paths such as `\marmotta` and device paths such as `\\?\` or `\\.\` are not accepted. `~` is not expanded, and values with leading or trailing whitespace are rejected instead of being trimmed. Invalid values are rejected with `MARMOTTA_HOME_INVALID`.
- An empty value is treated as unset.
- Marmotta creates the directory, and the subdirectories it needs, when a command first writes to it. If a directory cannot be created or written, for example when building, the command fails with `MARMOTTA_HOME_UNAVAILABLE` and names the directory and the cause. A failed Zig installation keeps its `ZIG_INSTALL_FAILED` code and includes the same details. Commands that write nothing, such as `marmotta list`, or `configure` and `install` when Zig is already available, also work with a read-only directory.
- When `MARMOTTA_HOME` is set, Zig's global cache is placed in `<MARMOTTA_HOME>/cache`, so builds do not write to the home directory. If `ZIG_GLOBAL_CACHE_DIR` is already set to a non-empty value, Marmotta leaves it unchanged. Without `MARMOTTA_HOME`, Marmotta does not change the cache location and Zig uses its own default.
- Marmotta only removes files and directories it created, such as a Zig version removed with `marmotta remove` or temporary build directories. It never deletes or cleans the `MARMOTTA_HOME` directory itself, so it can point to a shared location.

## Contributing

Bug reports, documentation improvements, and code contributions are welcome. See the [contributing guide](CONTRIBUTING.md) for project contribution and review guidelines.

## License

Marmotta is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the full license text.

## Team

- [Nicola Del Gobbo](https://github.com/NickNaso)

## Contributors

- [Simone Russo](https://github.com/ErRusso)
