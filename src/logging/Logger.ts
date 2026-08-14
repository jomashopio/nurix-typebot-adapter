export type LogFields = Record<
  string,
  string | number | boolean | null | undefined
>;

export type Logger = {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
};

export const createJsonLogger = (): Logger => ({
  info: (event, fields) => writeLog("info", event, fields),
  warn: (event, fields) => writeLog("warn", event, fields),
  error: (event, fields) => writeLog("error", event, fields),
});

export const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const writeLog = (level: string, event: string, fields?: LogFields) => {
  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...fields,
    })}\n`,
  );
};
