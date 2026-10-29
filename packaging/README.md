# Packaging Marmotta

This directory contains the package-manager recipes for Marmotta. They are rendered from the
release executables and the `SHA256SUMS` asset that the `Release binaries` workflow publishes.

## Generated output

`node scripts/packages.mjs` writes to `packaging/out/` (git-ignored):

```text
packaging/out/
├── artifacts/                 # .deb, .rpm, .apk, and .pkg.tar.zst packages (with --build)
├── nfpm/                      # nfpm configs used to build the native packages
├── recipes/
│   ├── homebrew/marmotta.rb
│   ├── aur/PKGBUILD
│   ├── rpm/marmotta.spec
│   ├── alpine/APKBUILD
│   ├── nix/default.nix
│   ├── scoop/marmotta.json
│   └── winget/
└── manifest.json
```

## Generating recipes

Download the assets of a release and render everything:

```sh
gh release download v0.8.0 --dir dist
node scripts/packages.mjs --version 0.8.0 --sums dist/SHA256SUMS --artifacts dist --out packaging/out
```

To compute the checksums from binaries that are already on disk instead of using `SHA256SUMS`:

```sh
node scripts/packages.mjs --artifacts dist --out packaging/out
```

## Building native Linux packages

The `.deb`, `.rpm`, `.apk`, and Arch Linux packages are built with
[nfpm](https://nfpm.goreleaser.com/):

```sh
# https://github.com/goreleaser/nfpm/releases
node scripts/packages.mjs --artifacts dist --out packaging/out --build
```

The script verifies every package after building it: metadata (name, version, architecture) and
the installed files are read back from each package. Verification needs `tar` and `ar`; it uses
`rpm` or `bsdtar` to list RPM contents, and `bsdtar` (or `tar` with zstd support) for Arch Linux
packages. When `--sums` and `--build` are combined, the executables in `--artifacts` are checked
against `SHA256SUMS` before any package is built, so a stale `dist/` cannot produce packages that
disagree with the published checksums.

Only plain `MAJOR.MINOR.PATCH` versions are supported: nfpm rewrites pre-release and build
metadata differently per package format, which would make the generated spec and APKBUILD invalid.

The recipes reference `LICENSE` at tag `v<version>`. When that tag exists locally, the renderer
hashes the committed blob from the tag (`git show v<version>:LICENSE`); otherwise it uses the
working tree, so render an older version from a checkout of that tag. The Alpine recipe also needs
the release executables in `--artifacts` to compute the SHA-512 checksums that aports requires.

The `.apk` packages built by nfpm are unsigned. Add `--allow-untrusted` when installing them
directly, or sign them for a repository.

The release workflow installs a pinned nfpm version through
`.github/actions/setup-packaging`, runs `node --test test/packaging.test.js` with that nfpm, and
attaches the results to the GitHub release together with `SHA256SUMS.packages` and
`marmotta-vX.Y.Z-packaging.tar.gz` (the rendered recipes and their manifest). Packaging runs in a
separate job after the binary release, so a packaging failure never blocks the executables.

A second CI job renders the recipes from fixture checksums and runs each one through its consumer:
`ruby -c` for the formula, `abuild validate` for the APKBUILD, `makepkg --printsrcinfo` for the
PKGBUILD, `rpmspec -P` and `rpmspec -q` for the spec, and `nix-instantiate --parse` for the Nix
expression. This catches recipe syntax that filling in the placeholders alone would not.

## Package-manager notes

| Manager | Recipe | Runtime notes |
| --- | --- | --- |
| Homebrew | `homebrew/marmotta.rb` | Installs the standalone binary from the release; no Node.js or npm required. macOS binaries are ad-hoc signed and not notarized. |
| AUR | `aur/PKGBUILD` | `marmotta-bin`, `x86_64` and `aarch64`, glibc binaries. Depends on `glibc`. |
| Arch Linux | built by nfpm | Same binary and dependencies as the AUR package. |
| Debian/Ubuntu | built by nfpm | Depends on `libc6`; the binary is the glibc build. |
| Fedora/RHEL | built by nfpm | Depends on `glibc`; `rpm/marmotta.spec` is provided for dist-git submissions. |
| Alpine | built by nfpm, `alpine/APKBUILD` | Uses the musl binaries and depends on `libstdc++` and `libgcc`. The single APKBUILD covers `x86_64` and `aarch64`, selects the source with a `$CARCH` case, and uses `sha512sums` as aports expects. The nfpm-built `.apk` files are unsigned, so install them with `apk add --allow-untrusted` unless you sign them for a repository. |
| Nix | `nix/default.nix` | Fetches the standalone binary for the current system from the release. On Linux, `autoPatchelfHook` rewrites the interpreter for NixOS and stripping is disabled so the Bun payload stays intact. |
| Scoop | `scoop/marmotta.json` | Windows x64 and ARM64 executables. |
| winget | `winget/*.yaml` | Portable installer for Windows x64 and ARM64. |

All packages install a `marmotta` executable. Zig is downloaded on first use unless a compatible
Zig is already on `PATH`, `MARMOTTA_ZIG_DIR` is set, or a release pins `zigVersion`. Package
maintainers may want to add Zig as an optional/recommended dependency so first use works offline.

## Publishing checklist

Packages are attached to every GitHub release so users can install them directly. Publishing to
the package-manager repositories themselves still happens from those repositories:

1. **Homebrew**: copy `homebrew/marmotta.rb` into the `napi-bindings/homebrew-tap` repository (or
   submit it to `homebrew-core`), update the tap, and run `brew audit --strict`.
2. **AUR**: push `aur/PKGBUILD` to the `marmotta-bin` AUR repository and run
   `makepkg --printsrcinfo > .SRCINFO` before committing.
3. **Debian/Ubuntu**: upload the `.deb` files to an APT repository with `dpkg-scanpackages`, or
   submit the package to Debian/Ubuntu. Generate `Packages`/`Release` metadata for the repository.
4. **Fedora/RHEL**: submit `rpm/marmotta.spec` through dist-git or build it in COPR. Upload the
   source asset to the lookaside cache.
5. **Alpine**: submit `alpine/APKBUILD` to `alpinelinux/aports` (or build it with `abuild`).
6. **Nixpkgs**: add `nix/default.nix` to `pkgs/by-name/ma/marmotta/package.nix`, or expose it as a
   flake/overlay first.
7. **Scoop**: copy `scoop/marmotta.json` to a Scoop bucket.
8. **winget**: submit the three files under `winget/` to `microsoft/winget-pkgs` with
   `wingetcreate submit`.

The recipes are version-specific, so regenerate them from the new `SHA256SUMS` for every release.
The release workflow does this automatically and uploads `marmotta-vX.Y.Z-packaging.tar.gz`.
