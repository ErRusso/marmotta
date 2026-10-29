class Marmotta < Formula
  desc "{{DESCRIPTION}}"
  homepage "{{REPOSITORY}}"
  version "{{VERSION}}"
  license "Apache-2.0"

  on_macos do
    on_arm do
      url "{{REPOSITORY}}/releases/download/v{{VERSION}}/{{ASSET_DARWIN_ARM64}}", using: :nounzip
      sha256 "{{SHA256_DARWIN_ARM64}}"
    end
    on_intel do
      url "{{REPOSITORY}}/releases/download/v{{VERSION}}/{{ASSET_DARWIN_X64}}", using: :nounzip
      sha256 "{{SHA256_DARWIN_X64}}"
    end
  end

  on_linux do
    on_arm do
      url "{{REPOSITORY}}/releases/download/v{{VERSION}}/{{ASSET_LINUX_ARM64}}", using: :nounzip
      sha256 "{{SHA256_LINUX_ARM64}}"
    end
    on_intel do
      url "{{REPOSITORY}}/releases/download/v{{VERSION}}/{{ASSET_LINUX_X64}}", using: :nounzip
      sha256 "{{SHA256_LINUX_X64}}"
    end
  end

  livecheck do
    url :stable
    strategy :github_latest
  end

  def install
    binary = Dir["marmotta-v*"].find { |path| File.file?(path) }
    raise "marmotta executable not found in the downloaded asset" if binary.nil?

    bin.install binary => "marmotta"
  end

  test do
    assert_match "marmotta #{version}", shell_output("#{bin}/marmotta --version")
  end
end
