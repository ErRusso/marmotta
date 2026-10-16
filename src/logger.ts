import { inspect } from 'node:util';
import pino, { type DestinationStream, type Logger as PinoLogger } from 'pino';

export type LogFormat = 'text' | 'json';
export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

type LogSink = (line: string) => void;

export interface LoggerOptions {
  format?: LogFormat;
  /** Lowest level that produces output. Defaults to MARMOTTA_LOG, or "info" when unset or invalid. */
  level?: string;
  stdout?: LogSink;
  stderr?: LogSink;
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
  private levelName?: string;
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
    // Resolved on first use, so the format is already settled and an invalid value is reported
    // through the same channel as every other record.
    this.requestedLevel = (options.level ?? process.env.MARMOTTA_LOG ?? 'info').toLowerCase();
  }

  get format(): LogFormat {
    return this.logFormat;
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

  private resolveLevel(): void {
    if (this.minLevel !== undefined) return;
    const value = levelValues[this.requestedLevel];
    if (value !== undefined) {
      this.levelName = this.requestedLevel;
      this.minLevel = value;
      return;
    }
    this.levelName = 'info';
    this.minLevel = levelValues.info;
    this.warn(`marmotta: ignoring invalid MARMOTTA_LOG value ${JSON.stringify(this.requestedLevel)}; using "info"`);
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    this.resolveLevel();
    if (levelValues[level] < this.minLevel!) return;
    if (this.logFormat === 'json') this.logJson(level, message, data);
    else this.logText(level, message, data);
  }

  // pino newline-terminates every record, so stdout stays valid JSON Lines across many records,
  // and it serializes circular context as "[Circular]" instead of dropping the whole payload.
  private logJson(level: LogLevel, message: string, data?: unknown): void {
    const target = this.jsonLogger(level === 'warn' || level === 'error' ? 'stderr' : 'stdout');
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
      level: this.levelName,
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
  return { write: (line: string) => void sink(line) };
}

// Default logger instance for use throughout the application
export const logger = new Logger();
