type Level = 'info' | 'warn' | 'error';

function emit(level: Level, scope: string, msg: string, extra?: unknown) {
    const line = `[${new Date().toISOString()}] ${level.toUpperCase()} (${scope}) ${msg}`;
    if (level === 'error') console.error(line, extra ?? '');
    else if (level === 'warn') console.warn(line, extra ?? '');
    else console.log(line, extra ?? '');
}

export const log = {
    info: (scope: string, msg: string, extra?: unknown) => emit('info', scope, msg, extra),
    warn: (scope: string, msg: string, extra?: unknown) => emit('warn', scope, msg, extra),
    error: (scope: string, msg: string, extra?: unknown) => emit('error', scope, msg, extra),
};
