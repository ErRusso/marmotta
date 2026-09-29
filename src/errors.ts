export type MarmottaErrorCode =
  | 'CLI_ARGUMENT_ERROR'
  | 'CLI_COMMAND_ERROR'
  | 'PROJECT_CONFIG_INVALID'
  | 'PROJECT_CONFIG_READ_FAILED'
  | 'PROJECT_PACKAGE_READ_FAILED'
  | 'PROJECT_SOURCE_INVALID'
  | 'PROJECT_SOURCE_NOT_FOUND'
  | 'PROJECT_SOURCE_READ_FAILED'
  | 'PROJECT_SOURCES_NOT_FOUND'
  | 'PLATFORM_NOT_SUPPORTED'
  | 'MARMOTTA_DIRECTORY_FAILED'
  | 'ZIG_DISCOVERY_FAILED'
  | 'ZIG_DOWNLOAD_FAILED'
  | 'ZIG_INSTALL_FAILED'
  | 'ZIG_CHECKSUM_MISMATCH'
  | 'ZIG_VERSION_INVALID'
  | 'TOOLCHAIN_SPAWN_FAILED'
  | 'TOOLCHAIN_COMMAND_FAILED'
  | 'INTERNAL_ERROR';

type MarmottaErrorOptions = {
  cause?: unknown;
  exitCode?: number;
};

export class MarmottaError extends Error {
  readonly code: MarmottaErrorCode;
  readonly exitCode: number;

  constructor(code: MarmottaErrorCode, message: string, options: MarmottaErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'MarmottaError';
    this.code = code;
    this.exitCode = options.exitCode ?? 1;
  }
}

export function isMarmottaError(error: unknown): error is MarmottaError {
  return error instanceof Error
    && 'code' in error
    && typeof error.code === 'string'
    && 'exitCode' in error
    && typeof error.exitCode === 'number';
}

export function normalizeError(error: unknown): MarmottaError {
  if (isMarmottaError(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new MarmottaError('INTERNAL_ERROR', message, { cause: error });
}