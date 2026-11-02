const SENSITIVE = /pan|card|cvv|token|secret|signature|authorization|password|senha|pix[_-]?key|private/i;

type Level = 'debug' | 'info' | 'warn' | 'error';

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE.test(key) ? '[redacted]' : redact(entry, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 300) return `${value.slice(0, 300)}…`;
  return value;
}

function emit(level: Level, event: string, data?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...(data ? (redact(data) as Record<string, unknown>) : {}),
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, data?: Record<string, unknown>) => {
    if (process.env.LOG_LEVEL === 'debug') emit('debug', event, data);
  },
  info: (event: string, data?: Record<string, unknown>) => emit('info', event, data),
  warn: (event: string, data?: Record<string, unknown>) => emit('warn', event, data),
  error: (event: string, data?: Record<string, unknown>) => emit('error', event, data),
};
