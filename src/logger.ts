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
  /** Level of the record, which also picks the stream: warn and error go to stderr. Defaults to "info". */
  level?: LogLevel;
}

// pino's level scale also drives the plain-text gate. "silent" is accepted by pino but is not part
// of its value table.
function levelValue(level: string): number | undefined {
  if (level === 'silent') return Infinity;
  // Object.hasOwn rejects inherited names such as "constructor" or "__proto__", which would
  // otherwise resolve to prototype members and silently disable the gate.
  return Object.hasOwn(pino.levels.values, level) ? pino.levels.values[level] : undefined;
}

function isStderrLevel(level: LogLevel): boolean {
  return level === 'warn' || level === 'error';
}

// inspect handles circular references, prototypes and throwing accessors without failing, which
// keeps the plain-text payload best-effort even for context that JSON cannot represent.
function formatTextData(data: unknown): string {
  try {
    return inspect(data, { depth: null, colors: false, breakLength: 100 });
  } catch {
    return '[unserializable data]';
  }
}

type JsonLoggers = {
  /** Gated by the requested level, like the plain-text diagnostics. */
  diagnostics: PinoLogger;
  /** Shares the destination but is never gated, for command output. */
  output: PinoLogger;
};

export class Logger {
  private readonly requestedLevel: string;
  private readonly level: string;
  private readonly minLevel: number;
  private readonly stdoutSink: LogSink;
  private readonly stderrSink: LogSink;
  private readonly customSinks: boolean;
  private logFormat: LogFormat;
  private levelChecked = false;
  private json?: JsonLoggers;

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
    const value = levelValue(this.requestedLevel);
    this.level = value === undefined ? 'info' : this.requestedLevel;
    this.minLevel = value ?? levelValue('info')!;
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

  /**
   * Warns, once, when the requested level was not recognized and "info" is used instead. Call it
   * after the output format is final, so the warning is written in that format.
   */
  checkLevel(): void {
    if (this.levelChecked) return;
    this.levelChecked = true;
    if (this.level === this.requestedLevel) return;
    this.warn(`marmotta: ignoring invalid MARMOTTA_LOG value ${JSON.stringify(this.requestedLevel)}; using "info"`);
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
    const { data, text, level = 'info' } = options;
    if (this.logFormat === 'json') this.writeJson(this.jsonLoggers().output, level, message, data);
    else (isStderrLevel(level) ? this.stderrSink : this.stdoutSink)(text ?? message);
  }

  /** Writes the final CLI error; it is always printed, on stderr. */
  failure(message: string, data?: unknown, text?: string): void {
    this.output(message, { data, text, level: 'error' });
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    if (this.logFormat === 'json') {
      this.writeJson(this.jsonLoggers().diagnostics, level, message, data);
      return;
    }
    if (levelValue(level)! < this.minLevel) return;
    const line = data === undefined ? message : `${message}\n${formatTextData(data)}`;
    (isStderrLevel(level) ? this.stderrSink : this.stdoutSink)(line);
  }

  // pino serializes circular context as "[Circular]" instead of dropping the payload.
  private writeJson(target: PinoLogger, level: LogLevel, message: string, data?: unknown): void {
    if (data === undefined) target[level](message);
    else target[level]({ data }, message);
  }

  // Both loggers write through one multistream that sends warn and above to stderr and everything
  // else to stdout; dedupe keeps a warn or error record off stdout.
  private jsonLoggers(): JsonLoggers {
    if (this.json) return this.json;
    const stdout = this.customSinks ? sinkDestination(this.stdoutSink) : standardDestination(1);
    const stderr = this.customSinks ? sinkDestination(this.stderrSink) : standardDestination(2);
    const destination = pino.multistream([
      { level: 'trace', stream: stdout },
      { level: 'warn', stream: stderr },
    ], { dedupe: true });
    const diagnostics = pino({
      level: this.level,
      messageKey: 'message',
      formatters: {
        level: (label: string) => ({ level: label }),
        bindings: () => ({}),
      },
    }, destination);
    this.json = { diagnostics, output: diagnostics.child({}, { level: 'trace' }) };
    return this.json;
  }
}

function standardDestination(fd: 1 | 2): DestinationStream {
  const destination = pino.destination({ dest: fd, sync: true });
  // A downstream reader such as `head` can close the pipe early; console.* would silently absorb
  // the write error, and the logger must not crash the process where console would not.
  destination.on('error', () => {});
  return destination;
}

function sinkDestination(sink: LogSink): DestinationStream {
  // pino terminates JSON records with a newline; the sink contract is one unterminated line per
  // call, so strip it before handing the line over.
  return { write: (line: string) => void sink(line.replace(/\n$/, '')) };
}

// Default logger instance for use throughout the application
export const logger = new Logger();
