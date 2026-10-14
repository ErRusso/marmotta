export type LogFormat = 'text' | 'json';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

type LogSink = (line: string) => void;

export interface LoggerOptions {
  debug?: boolean;
  format?: LogFormat;
  stdout?: LogSink;
  stderr?: LogSink;
}

function formatTextData(data: unknown): string {
  try {
    const serialized = JSON.stringify(data, null, 2);
    return serialized === undefined ? `\n${String(data)}` : `\n${serialized}`;
  } catch {
    return `\n${String(data)}`;
  }
}

function formatJsonEntry(level: LogLevel, message: string, data?: unknown): string {
  const entry: Record<string, unknown> = { level, message };
  if (data !== undefined) entry.data = data;
  try {
    return JSON.stringify(entry);
  } catch {
    // Keep the record valid even when context contains a circular value.
    entry.data = String(data);
    return JSON.stringify(entry);
  }
}

export class Logger {
  private debugMode: boolean;
  private format: LogFormat;
  private stdout: LogSink;
  private stderr: LogSink;

  constructor(options: LoggerOptions = {}) {
    this.debugMode = options.debug ?? false;
    this.format = options.format ?? 'text';
    this.stdout = options.stdout ?? ((line) => process.stdout.write(line));
    this.stderr = options.stderr ?? ((line) => process.stderr.write(line));
  }

  setDebugMode(debugMode: boolean): void {
    this.debugMode = debugMode;
  }

  setFormat(format: LogFormat): void {
    if (format !== 'text' && format !== 'json') {
      throw new TypeError(`Unsupported log format: ${String(format)}`);
    }
    this.format = format;
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
    if (!this.debugMode) return;
    this.log('debug', message, data);
  }

  private log(level: LogLevel, message: string, data?: unknown): void {
    if (!message) return;

    const line = this.format === 'json'
      ? formatJsonEntry(level, message, data)
      : this.formatTextMessage(level, message, data);
    const sink = level === 'warn' || level === 'error' ? this.stderr : this.stdout;
    sink(line);
  }

  private formatTextMessage(level: LogLevel, message: string, data?: unknown): string {
    const normalizedMessage = message.replace(/\r?\n/g, ' ');
    const line = `[${level.toUpperCase()}] ${normalizedMessage}`;
    return this.debugMode && data !== undefined ? `${line}${formatTextData(data)}` : line;
  }
}

// Default logger instance for use throughout the application
export const logger = new Logger();
