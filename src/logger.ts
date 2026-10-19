import { inspect } from 'node:util';
import pino, { type DestinationStream, type Logger as PinoLogger } from 'pino';

export type LogFormat = 'text' | 'json';
export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

/**
 * Receives one record per call, without a trailing newline, in both text and JSON mode, so the
 * same sink works for either format.
 */
type LogSink = (line: string) => void;

export interface LoggerOptions {
  format?: LogFormat;
  /** Lowest level that produces output. Defaults to MARMOTTA_LOG, or "info" when unset or invalid. */
  level?: string;
  stdout?: LogSink;
  stderr?: LogSink;
}

export interface OutputOptions {
  /** Structured context merged into the JSON record. Ignored in text mode. */
  data?: unknown;
  /** Text written instead of the message in text mode, for results that render differently. */
  text?: string;
  /** Destination stream. Defaults to stdout. */
  stream?: 'stdout' | 'stderr';
  /** Level of the JSON record. Defaults to "info". */
  level?: LogLevel;
}

// pino uses the same scale, so one table drives both the JSON writers and the plain-text gate.
const levelValues: Record<string, number> = pino.levels.values;

// inspect handles circular references, prototypes and throwing accessors without failing, which
// keeps the plain-text payload best-effort even for context that JSON cannot represent.
function formatTextData(data: unknown): string {
  try {
    return inspect(data, { depth: null, colors: false, breakLength: 100 });
  } catch {
    return '[unserializable data]';
  }
}

export class Logger {
  private readonly requestedLevel: string;
  private readonly stdoutSink: LogSink;
  private readonly stderrSink: LogSink;
  private readonly customSinks: boolean;
  private logFormat: LogFormat;
  private minLevel?: number;
  private jsonStdout?: PinoLogger;
  private jsonStderr?: PinoLogger;

  constructor(options: LoggerOptions = {}) {
    this.logFormat = options.format ?? 'text';
    this.customSinks = options.stdout !== undefined || options.stderr !== undefined;
    // console.* appends the newline, keeps multi-line messages intact and passes them through
    // unchanged, and silently absorbs errors from closed pipes, so text output stays
    // byte-compatible with the plain console usage this logger replaces.
    this.stdoutSink = options.stdout ?? ((line) => console.log(line));
    this.stderrSink = options.stderr ?? ((line) => console.error(line));
    // Empty or whitespace-only counts as unset, matching MARMOTTA_HOME and MARMOTTA_ZIG_DIR.
    const requested = (options.level ?? process.env.MARMOTTA_LOG ?? '').trim();
    this.requestedLevel = requested === '' ? 'info' : requested.toLowerCase();
  }

  get format(): LogFormat {
    return this.logFormat;
  }

  /** Child process output must be captured and re-emitted as records in JSON mode. */
  get capturesChildOutput(): boolean {
    return this.logFormat === 'json';
  }

  setFormat(format: LogFormat): void {
    if (format !== 'text' && format !== 'json') {
      throw new TypeError(`Unsupported log format: ${String(format)}`);
    }
    this.logFormat = format;
  }

  info(message: string, data?: unknown): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: unknown): void {
    this.log('error', message, data);
  }

  debug(message: string, data?: unknown): void {
    this.log('debug', message, data);
  }

  /**
   * Writes a command result. Level filtering never applies: MARMOTTA_LOG controls diagnostics, not
   * the command's own output, so `--version`, `list`, confirmations and compiler output stay
   * visible even when MARMOTTA_LOG is set to "error" or "silent".
   */
  output(message: string, options: OutputOptions = {}): void {
    this.resolveLevel();
    const { data, text, stream = 'stdout', level = 'info' } = options;
    if (this.logFormat === 'json') this.writeJson(stream, level, message, data);
    else (stream === 'stderr' ? this.stderrSink : this.stdoutSink)(text ?? message);
  }

  /** Writes the final CLI error; it is always printed, on stderr. */
  failure(message: string, data?: unknown, text?: string): void {
    this.output(message, { data, text, stream: 'stderr', level: 'error' });
  }

  private resolveLevel(): void {
    if (this.minLevel !== undefined) return;
    // Object.hasOwn rejects inherited names such as "constructor" or "__proto__", which would
    // otherwise resolve to prototype members and silently disable the gate.
    const value = Object.hasOwn(levelValues, this.requestedLevel) ? levelValues[this.requestedLevel] : undefined;
    if (typeof value === 'number') {
      this.minLevel = value;
      return;
    }
    this.minLevel = levelValues.info;
    this.warn(`marmotta: ignoring invalid MARMOTTA_LOG value ${JSON.stringify(this.requestedLevel)}; using "info"`);
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    this.resolveLevel();
    if (levelValues[level] < this.minLevel!) return;
    if (this.logFormat === 'json') this.logJson(level, message, data);
    else this.logText(level, message, data);
  }

  // pino is configured at "trace" so log() performs the only level filtering. output() records
  // therefore always pass, while pino still newline-terminates each record and serializes circular
  // context as "[Circular]" instead of dropping the payload.
  private logJson(level: LogLevel, message: string, data?: unknown): void {
    this.writeJson(level === 'warn' || level === 'error' ? 'stderr' : 'stdout', level, message, data);
  }

  private writeJson(stream: 'stdout' | 'stderr', level: LogLevel, message: string, data?: unknown): void {
    const target = this.jsonLogger(stream);
    if (data === undefined) target[level](message);
    else target[level]({ data }, message);
  }

  private logText(level: LogLevel, message: string, data?: unknown): void {
    const line = data === undefined ? message : `${message}\n${formatTextData(data)}`;
    (level === 'warn' || level === 'error' ? this.stderrSink : this.stdoutSink)(line);
  }

  private jsonLogger(stream: 'stdout' | 'stderr'): PinoLogger {
    const existing = stream === 'stdout' ? this.jsonStdout : this.jsonStderr;
    if (existing) return existing;
    const options = {
      level: 'trace',
      messageKey: 'message',
      formatters: {
        level: (label: string) => ({ level: label }),
        bindings: () => ({}),
      },
    };
    const sink = stream === 'stdout' ? this.stdoutSink : this.stderrSink;
    const logger = pino(options, this.customSinks ? sinkDestination(sink) : this.standardDestination(stream));
    if (stream === 'stdout') this.jsonStdout = logger;
    else this.jsonStderr = logger;
    return logger;
  }

  private standardDestination(stream: 'stdout' | 'stderr'): DestinationStream {
    const destination = pino.destination({ dest: stream === 'stdout' ? 1 : 2, sync: true });
    // A downstream reader such as `head` can close the pipe early; console.* would silently absorb
    // the write error, and the logger must not crash the process where console would not.
    destination.on('error', () => {});
    return destination;
  }
}

function sinkDestination(sink: LogSink): DestinationStream {
  // pino terminates JSON records with a newline; the sink contract is one unterminated line per
  // call, so strip it before handing the line over.
  return { write: (line: string) => void sink(line.replace(/\n$/, '')) };
}

// Default logger instance for use throughout the application
export const logger = new Logger();
