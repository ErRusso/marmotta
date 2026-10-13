export class Logger {
  private debugMode: boolean;

  constructor(debugMode: boolean = false) {
    this.debugMode = debugMode;
  }

  setDebugMode(debugMode: boolean): void {
    this.debugMode = debugMode;
  }

  info(message: string, data?: unknown): void {
    if (message) {
      console.log(`[INFO] ${message}`);
      if (this.debugMode && data !== undefined) {
        console.log(`  ${JSON.stringify(data, null, 2)}`);
      }
    }
  }

  warn(message: string, data?: unknown): void {
    if (message) {
      console.warn(`[WARN] ${message}`);
      if (this.debugMode && data !== undefined) {
        console.warn(`  ${JSON.stringify(data, null, 2)}`);
      }
    }
  }

  error(message: string, data?: unknown): void {
    if (message) {
      console.error(`[ERROR] ${message}`);
      if (this.debugMode && data !== undefined) {
        console.error(`  ${JSON.stringify(data, null, 2)}`);
      }
    }
  }

  debug(message: string, data?: unknown): void {
    if (this.debugMode && message) {
      console.log(`[DEBUG] ${message}`);
      if (data !== undefined) {
        console.log(`  ${JSON.stringify(data, null, 2)}`);
      }
    }
  }
}

// Default logger instance for use throughout the application
export const logger = new Logger();
