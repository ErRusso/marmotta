%global debug_package %{nil}
# The executable is a Bun single-file binary with an appended payload, so brp-strip must not touch
# it. Overriding __strip makes the strip BRP script a no-op without disabling every other BRP pass.
%global __strip /bin/true

%ifarch x86_64
%global asset {{ASSET_LINUX_X64}}
%endif
%ifarch aarch64
%global asset {{ASSET_LINUX_ARM64}}
%endif

Name:           marmotta
Version:        {{VERSION}}
Release:        1%{?dist}
Summary:        {{DESCRIPTION}}
License:        Apache-2.0
URL:            {{REPOSITORY}}
Source0:        %{url}/releases/download/v%{version}/%{asset}
Source1:        {{LICENSE_URL}}
ExclusiveArch:  x86_64 aarch64
Requires:       glibc

%description
Marmotta builds Node.js native addons written in C or C++ with Node-API. It uses
Zig as the compiler toolchain and can install Zig for you, so projects do not
need to configure node-gyp or CMake. This package contains the standalone
executable, which does not require Node.js or npm.

%prep
# The release asset is a prebuilt executable, so there is nothing to unpack.

%build
# Nothing to build.

%install
install -Dm0755 %{SOURCE0} %{buildroot}%{_bindir}/marmotta
install -Dm0644 %{SOURCE1} %{buildroot}%{_licensedir}/marmotta/LICENSE

%files
%{_bindir}/marmotta
%license %{_licensedir}/marmotta/LICENSE

%changelog
* {{CHANGELOG_DATE}} {{MAINTAINER}} - {{VERSION}}-1
- Package Marmotta {{VERSION}}.
