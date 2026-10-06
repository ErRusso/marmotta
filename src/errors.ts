import { createError, MarmottaError } from './create-error.js';

export { MarmottaError };

const USAGE_EXIT_CODE = 2;
const FAILURE_EXIT_CODE = 1;

export const CliArgumentError = createError('CLI_ARGUMENT_ERROR', '%s', USAGE_EXIT_CODE);
export const CliCommandError = createError('CLI_COMMAND_ERROR', '%s', USAGE_EXIT_CODE);

export const ProjectConfigInvalidError = createError('PROJECT_CONFIG_INVALID', '%s', FAILURE_EXIT_CODE);
export const ProjectConfigReadFailedError = createError(
  'PROJECT_CONFIG_READ_FAILED',
  'Unable to read %s.',
  FAILURE_EXIT_CODE,
);
export const ProjectConfigLoadFailedError = createError(
  'PROJECT_CONFIG_LOAD_FAILED',
  'Unable to load %s.',
  FAILURE_EXIT_CODE,
);
export const ProjectPackageReadFailedError = createError(
  'PROJECT_PACKAGE_READ_FAILED',
  'Unable to read package.json in %s.',
  FAILURE_EXIT_CODE,
);
export const ProjectSourceInvalidError = createError(
  'PROJECT_SOURCE_INVALID',
  'Source is not a file: %s',
  FAILURE_EXIT_CODE,
);
export const ProjectSourceNotFoundError = createError(
  'PROJECT_SOURCE_NOT_FOUND',
  'Source not found: %s',
  FAILURE_EXIT_CODE,
);
export const ProjectSourceReadFailedError = createError('PROJECT_SOURCE_READ_FAILED', '%s', FAILURE_EXIT_CODE);
export const ProjectSourcesNotFoundError = createError(
  'PROJECT_SOURCES_NOT_FOUND',
  'No C/C++ sources found. Add "sources" to marmotta.config.json.',
  FAILURE_EXIT_CODE,
);

export const PlatformNotSupportedError = createError(
  'PLATFORM_NOT_SUPPORTED',
  'Unsupported platform: %s',
  FAILURE_EXIT_CODE,
);
export const MarmottaDirectoryFailedError = createError(
  'MARMOTTA_DIRECTORY_FAILED',
  'Unable to create %s.',
  FAILURE_EXIT_CODE,
);

export const ZigDiscoveryFailedError = createError('ZIG_DISCOVERY_FAILED', '%s', FAILURE_EXIT_CODE);
export const ZigDownloadFailedError = createError('ZIG_DOWNLOAD_FAILED', '%s', FAILURE_EXIT_CODE);
export const ZigInstallFailedError = createError('ZIG_INSTALL_FAILED', '%s', FAILURE_EXIT_CODE);
export const ZigChecksumMismatchError = createError(
  'ZIG_CHECKSUM_MISMATCH',
  'Invalid Zig package checksum.',
  FAILURE_EXIT_CODE,
);
export const ZigVersionInvalidError = createError('ZIG_VERSION_INVALID', 'Invalid Zig version: %s', USAGE_EXIT_CODE);

export const ToolchainSpawnFailedError = createError(
  'TOOLCHAIN_SPAWN_FAILED',
  'Unable to start %s.',
  FAILURE_EXIT_CODE,
);
export const ToolchainCommandFailedError = createError('TOOLCHAIN_COMMAND_FAILED', '%s %s.', FAILURE_EXIT_CODE);

export const InternalError = createError('INTERNAL_ERROR', '%s', FAILURE_EXIT_CODE);

export function isMarmottaError(error: unknown): error is MarmottaError {
  return error instanceof MarmottaError;
}

export function normalizeError(error: unknown): MarmottaError {
  if (isMarmottaError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new InternalError(message, { cause: error });
}
