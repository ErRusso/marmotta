{
  lib,
  stdenv,
  fetchurl,
}:

let
  version = "{{VERSION}}";
  sources = {
    x86_64-linux = {
      url = "{{REPOSITORY}}/releases/download/v${version}/{{ASSET_LINUX_X64}}";
      hash = "{{SRI_LINUX_X64}}";
    };
    aarch64-linux = {
      url = "{{REPOSITORY}}/releases/download/v${version}/{{ASSET_LINUX_ARM64}}";
      hash = "{{SRI_LINUX_ARM64}}";
    };
    x86_64-darwin = {
      url = "{{REPOSITORY}}/releases/download/v${version}/{{ASSET_DARWIN_X64}}";
      hash = "{{SRI_DARWIN_X64}}";
    };
    aarch64-darwin = {
      url = "{{REPOSITORY}}/releases/download/v${version}/{{ASSET_DARWIN_ARM64}}";
      hash = "{{SRI_DARWIN_ARM64}}";
    };
  };
  source =
    sources.${stdenv.hostPlatform.system}
      or (throw "marmotta: unsupported system ${stdenv.hostPlatform.system}");
in
stdenv.mkDerivation {
  pname = "marmotta";
  inherit version;

  src = fetchurl {
    inherit (source) url hash;
  };

  dontUnpack = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    install -Dm755 "$src" "$out/bin/marmotta"
    runHook postInstall
  '';

  meta = {
    description = "{{DESCRIPTION}}";
    homepage = "{{REPOSITORY}}";
    license = lib.licenses.asl20;
    mainProgram = "marmotta";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "x86_64-darwin"
      "aarch64-darwin"
    ];
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
