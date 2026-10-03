# Marmotta

Marmotta builds Node.js native addons written in C or C++ with [Node-API](https://nodejs.org/api/n-api.html), using the Zig compiler. It manages the compiler toolchain for you and does not require `node-gyp` or CMake.

## Requirements

- Node.js 20 or later and npm.
- For automatic Zig downloads: an x64 or ARM64 host running Linux, macOS, or Windows. On other hosts, provide a usable Zig executable on `PATH`.
- An internet connection the first time Marmotta needs Zig, unless Zig is already available on your `PATH`.
- `tar` to extract Zig when Marmotta downloads it. It is available by default on current macOS, Linux, and Windows installations.

Marmotta supplies the Node-API headers through its npm dependency. You do not need to download Node headers or install a separate C/C++ compiler.

## Install Marmotta

Install Marmotta globally to use the `marmotta` command from any project:

```sh
npm install --global marmotta
marmotta --help
```

Alternatively, add it to a project and invoke it with `npx`:

```sh
npm install --save-dev marmotta
npx marmotta --help
```

The first command that needs the compiler (such as `install`, `configure`, or `build`) creates a `.marmotta` directory in the user's home directory (for example, `~/.marmotta`, or `%USERPROFILE%\.marmotta` on Windows). Marmotta first uses `zig` if it is available on `PATH`; otherwise, it downloads the latest stable Zig release for the current supported platform into that directory. The archive checksum is verified when the Zig download index provides one. No separate Zig setup is normally needed.

## Prepare a native-addon project

Create or open a Node.js project containing at least one C or C++ source file that implements a Node-API addon. Marmotta recognizes `.c`, `.cc`, `.cpp`, and `.cxx` files.

For predictable builds, add a `marmotta.config.json` file to the project root. Paths in this file are relative to that directory:

```json
{
  "name": "hello",
  "sources": ["src/hello.c"],
  "includeDirs": ["include"],
  "cFlags": [],
  "cxxFlags": ["-std=c++17"],
  "linkerFlags": [],
  "outputDir": "build"
}
```

Configuration fields:

| Field | Purpose |
| --- | --- |
| `name` | Addon name. Defaults to the `name` in `package.json`, or the project directory name if there is no package name. Characters other than letters, numbers, `_`, and `-` are replaced with `_`. |
| `sources` | C/C++ source-file paths. If omitted or empty, Marmotta recursively discovers source files in the project. |
| `includeDirs` | Additional header-search directories. Defaults to an empty array. |
| `cFlags` | Additional compiler flags for C files. Defaults to an empty array. |
| `cxxFlags` | Additional compiler flags for C++ files. Defaults to an empty array. |
| `linkerFlags` | Additional linker flags. Defaults to an empty array. |
| `outputDir` | Directory where the addon is generated, as `<outputDir>/<name>.node`. Relative paths are resolved from the project directory. Defaults to the project root. |

Each array field must be an array of strings. When source discovery is used, Marmotta ignores `.git`, `.marmotta`, `build`, `dist`, and `node_modules` directories. Explicit source paths are resolved relative to the project directory and must exist.

Your source must expose Node-API initialization code, for example using `NAPI_MODULE(...)`. Marmotta supplies the Node-API include path automatically. It also defines the `NODE_GYP_MODULE_NAME` macro for every source file, set to the addon `name` (with characters that are invalid in C identifiers replaced by `_`), so code written for node-gyp such as `NODE_API_MODULE(NODE_GYP_MODULE_NAME, Initialize)` builds unchanged. It compiles C and C++ files with their respective flags and links them into one `.node` file.

For example, save this as `src/hello.c` to export a JavaScript function named `hello`:

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

NAPI_MODULE(hello, Initialize)
```

## Build and use the addon

From the project root, configure the project and toolchain:

```sh
npx marmotta configure
```

Configuration is optional: `build` can be run directly and loads the project configuration itself. Build the addon:

```sh
npx marmotta build
```

If `outputDir` is `build` and the addon `name` is `hello`, the output is `build/hello.node`; load it from Node.js like any other native addon:

```sh
node -e "console.log(require('./build/hello.node').hello())"
```

Replace `hello` with a function exported by your addon. A `.node` file is loaded by `require()`; use the path to the output file generated by your build.

To compile without optimization and include debug information:

```sh
npx marmotta build --debug
```

By default, Marmotta uses `-O2`; `--debug` uses `-O0 -g`.

## CLI reference

For a complete usage summary, run `marmotta --help` (or `npx marmotta --help` for a local installation).

| Command | Description |
| --- | --- |
| `marmotta configure` | Validate the project configuration and ensure Zig is available. |
| `marmotta build` | Compile the configured or discovered C/C++ sources into a `.node` addon. |
| `marmotta rebuild` | Remove the selected addon file and build it again. |
| `marmotta clean` | Remove the generated addon file only; it does not remove Zig or other build files. |
| `marmotta install` | Ensure Zig is available. Uses Zig on `PATH` when present; otherwise downloads it. |
| `marmotta list` | List Zig versions managed in `~/.marmotta`. A system Zig on `PATH` is not listed. |
| `marmotta remove <version>` | Remove a managed Zig version, for example `marmotta remove 0.14.1`. Use a version shown by `list`. |

The following options apply to `configure`, `build`, `rebuild`, and `clean` as indicated:

| Option | Commands | Description |
| --- | --- | --- |
| `-C, --directory <path>` | `configure`, `build`, `rebuild`, `clean` | Project directory. Defaults to the current working directory. |
| `-o, --output-dir <path>` | `build`, `rebuild`, `clean` | Override the configured `outputDir`. Relative paths are resolved from the project directory. |
| `--target <triple>` | `build`, `rebuild` | Zig target triple for cross-compilation. |
| `--debug` | `build`, `rebuild` | Build without optimization and include debug information. |
| `-h, --help` | Any command | Show help. |
| `-v, --version` | Top-level command | Show the Marmotta version. |

For example, build an ARM64 macOS addon from another supported host:

```sh
npx marmotta build --target aarch64-macos
```

Zig target triples vary by operating system and architecture. Pass the triple supported by Zig for your intended target; Marmotta uses the selected target when compiling and linking.

## Zig toolchain management

Marmotta stores downloaded Zig toolchains and temporary build files under `~/.marmotta`. If a usable Zig executable is found on `PATH`, Marmotta uses it instead of downloading a managed copy. Otherwise, it downloads the latest stable release matching the host platform. The supported automatic-download platforms are x64 and ARM64 Linux, macOS, and Windows.

To prepare the compiler before building:

```sh
npx marmotta install
```

To inspect managed versions and remove one:

```sh
npx marmotta list
npx marmotta remove 0.14.1
```

`remove` only deletes a Zig version stored by Marmotta; it does not uninstall or modify a system Zig found on `PATH`.

## License

Marmotta is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the full license text.
