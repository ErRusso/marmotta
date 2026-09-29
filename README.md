# Marmotta

Marmotta builds Node.js native addons based on Node-API using Zig, without relying on node-gyp or CMake. It requires Node.js 20 or later. On first run, it creates `~/.marmotta`, reuses Zig if it is available on `PATH`, or downloads the stable release for the current system from ziglang.org. The download checksum is verified when provided by the official index.

## Installation and Commands

To develop or install the CLI locally:

```sh
npm install
npm run build
npm link
```

Available commands: `marmotta configure`, `build`, `rebuild`, `clean`, `install`, `list`, and `remove <version>`. `configure` validates the project configuration and prepares Zig; `build` can also be run directly. `install` prepares the toolchain, while `list` and `remove` manage only Zig versions downloaded by Marmotta.

Use `-C, --directory` to select the project for `configure`, `build`, `rebuild`, and `clean`. Use `-o, --out` to select the output file for `build`, `rebuild`, and `clean`; `--target` and `--debug` apply to `build` and `rebuild`. For example, to cross-compile:

```sh
marmotta build --target aarch64-macos
```

## Project Configuration

Marmotta reads `marmotta.config.json` from the project directory. If the file is missing, it recursively searches for `.c`, `.cc`, `.cpp`, and `.cxx` files, excluding dependency and build directories.

```json
{
  "name": "hello",
  "sources": ["hello.c"],
  "includeDirs": ["include"],
  "cFlags": [],
  "cxxFlags": ["-std=c++17"],
  "linkerFlags": [],
  "output": "build/hello.node"
}
```

Node-API headers are provided by the `node-api-headers` package. C and C++ sources are compiled separately and then linked into a single `.node` addon. On Windows, the Node-API import library is generated with `zig dlltool`. Zig and temporary build files are managed under `~/.marmotta`.