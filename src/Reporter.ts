import util from 'util';
import fs from 'fs';
import ora, { Ora } from 'ora';
import colorette from 'colorette';
import { LogEntry, LogType } from './types';
import { isVerbose, isWorker } from './env';

const IS_SYMBOL_SUPPORTED =
  process.platform !== 'win32' ||
  process.env.CI ||
  process.env.TERM === 'xterm-256color';

const SYMBOLS: Record<LogType, string> = {
  debug: colorette.gray('?'),
  info: colorette.blue('ℹ'),
  warn: colorette.yellow('⚠'),
  error: colorette.red('✖'),
};

const FALLBACK_SYMBOLS: Record<LogType, string> = {
  debug: colorette.gray('?'),
  info: colorette.blue('i'),
  warn: colorette.yellow('!'),
  error: colorette.red('x'),
};

interface ReqLogData {
  method: string;
  url: string;
}

interface ResLogData {
  statusCode: number;
}

/**
 * {@link Reporter} configuration options.
 */
export interface ReporterConfig {
  /** Whether to log additional debug messages. */
  verbose?: boolean;
}

/**
 * Class that handles all reporting, logging and compilation progress handling.
 */
export class Reporter {
  /**
   * Get message symbol for given log type.
   *
   * @param logType Log type.
   * @returns String with the symbol.
   *
   * @internal
   */
  static getSymbolForType(logType: LogType) {
    if (IS_SYMBOL_SUPPORTED) {
      return SYMBOLS[logType];
    }

    return FALLBACK_SYMBOLS[logType];
  }

  /**
   * Apply ANSI colors to given text.
   *
   * @param logType Log type for the text, based on which different colors will be applied.
   * @param text Text to apply the color onto.
   * @returns Text wrapped in ANSI color sequences.
   *
   * @internal
   */
  static colorizeText(logType: LogType, text: string) {
    if (logType === 'warn') {
      return colorette.yellow(text);
    } else if (logType === 'error') {
      return colorette.red(text);
    }

    return text;
  }

  /** Whether reporter is running as a worker. */
  public readonly isWorker: boolean;
  /** Whether reporter is running in verbose mode. */
  public readonly isVerbose: boolean;

  private ora?: Ora;
  private requestBuffer: Record<number, ReqLogData | undefined> = {};
  private fileLogBuffer: string[] = [];
  private outputFilename?: string;
  private progress: Record<string, { value: number; label: string }> = {};

  /**
   * Create new instance of Reporter.
   * If Reporter is running as a non-worker, it will start outputting to terminal.
   *
   * @param config Reporter configuration. Defaults to empty object.
   */
  constructor(private config: ReporterConfig = {}) {
    this.isWorker = isWorker();
    this.isVerbose = this.config.verbose ?? isVerbose();
    if (!this.isWorker) {
      this.ora = ora('Running...').start();
    }
  }

  /**
   * Stop reporting and perform cleanup.
   */
  stop() {
    if (!this.isWorker && this.ora) {
      this.ora.stop();
    }
  }

  /**
   * Enable reporting to file alongside reporting to terminal.
   *
   * @param filename Absolute path to file to which write logs.
   */
  enableFileLogging(filename: string) {
    this.outputFilename = filename;
  }

  /**
   * Flush all buffered logs to a file provided that file
   * reporting was enabled with {@link enableFileLogging}.
   */
  flushFileLogs() {
    if (this.outputFilename) {
      fs.writeFileSync(this.outputFilename, this.fileLogBuffer.join('\n'));
      this.fileLogBuffer = [];
    }
  }

  /**
   * Process new log entry and report it to terminal and file if file reporting was enabled with
   * {@link enableFileLogging}.
   *
   * @param logEntry Log entry to process & report.
   */
  process(logEntry: LogEntry) {
    if (this.outputFilename) {
      this.fileLogBuffer.push(JSON.stringify(logEntry));
    }

    // Skip debug logs if not in verbose mode
    if (logEntry.type === 'debug' && !this.isVerbose) {
      return;
    }

    // When reporter is running inside worker, simply stringify the entry
    // and use console to log it to stdout. It will be later caught by DevSeverProxy.
    if (this.isWorker) {
      console.log(JSON.stringify(logEntry));
    } else if (this.ora) {
      if (this.isProgress(logEntry)) {
        const {
          progress: { value, label, platform },
        } = logEntry.message[0] as {
          progress: { value: number; label: string; platform: string };
        };
        this.progress[platform] = { value, label };
        this.updateProgress();
      } else {
        const text = this.getOutputLogMessage(logEntry);
        // Ignore empty logs
        if (text) {
          this.ora.stopAndPersist({
            symbol: Reporter.getSymbolForType(logEntry.type),
            text: this.getOutputLogMessage(logEntry),
          });
          this.ora.start('Running...');
        }
      }
    }
  }

  private updateProgress() {
    let text = 'Running: ';
    for (const platform in this.progress) {
      const { value, label } = this.progress[platform];
      text += `(${platform}) ${label} ${Math.round(value * 100)}% `;
    }
    this.ora?.start(text);
  }

  private isProgress(logEntry: LogEntry) {
    return Boolean(logEntry.message?.[0]?.progress);
  }

  private getOutputLogMessage(logEntry: LogEntry) {
    let body = '';
    let issuer = logEntry.issuer;
    for (const value of logEntry.message) {
      if (typeof value === 'string') {
        body += Reporter.colorizeText(logEntry.type, value);
        body += ' ';
      } else {
        const {
          msg,
          req,
          reqId,
          res,
          responseTime, // eslint-disable-line @typescript-eslint/no-unused-vars
          issuer: issuerOverride,
          ...rest
        } = value as {
          msg?: string | string[];
          req?: ReqLogData;
          reqId?: number;
          res?: ResLogData;
          responseTime?: number;
          issuer?: string;
          [key: string]: any; // For all unknown fields
        };

        if (issuerOverride) {
          issuer = issuerOverride;
        }

        // Route logs from Fastify (DevServerProxy, DevServer)
        if ((req || res) && reqId !== undefined) {
          // Disable route logging if not verbose. It would better to do it on per-router/Fastify
          // level but unless webpack-dev-middleware is migrated to Fastify that's not a feasible solution.
          // TODO: silence route logs on per-router/Fastify
          if (!this.isVerbose) {
            continue;
          }

          if (req) {
            this.requestBuffer[reqId] = req;
            // Logs in the future should have a `res` with the same `reqId`, so we will be
            // able to match it. For now process next value.
            continue;
          }

          if (res) {
            const bufferedReq = this.requestBuffer[reqId];
            if (bufferedReq) {
              let rawStatus = `${bufferedReq.method} ${res.statusCode}`;
              let status = colorette.green(rawStatus);
              if (res.statusCode >= 500) {
                status = colorette.red(rawStatus);
              } else if (res.statusCode >= 400) {
                status = colorette.yellow(rawStatus);
              }

              body += `${status} ${colorette.gray(bufferedReq.url)}`;
              body += ' ';
              // Ignore msg/other data and process next value
              continue;
            } else {
              // Ignore and process next value
              continue;
            }
          }
        }

        // Usually non-route logs from Fastify (DevServerProxy, DevServer will have a `msg` field)
        if (msg) {
          if (Array.isArray(msg)) {
            for (const msgItem of msg) {
              body += Reporter.colorizeText(logEntry.type, msgItem);
              body += ' ';
            }
          } else {
            body += Reporter.colorizeText(logEntry.type, msg);
            body += ' ';
          }
        }

        if (Object.keys(rest).length) {
          body +=
            util.inspect(rest, {
              colors: true,
              depth: 3,
            }) + ' ';
        }
      }
    }

    // Ignore empty logs
    if (!body) {
      return undefined;
    }

    return (
      colorette.gray(
        `[${new Date(logEntry.timestamp).toISOString().split('T')[1]}]`
      ) +
      colorette.bold(`[${issuer}]`) +
      ` ${body}`
    );
  }
}
