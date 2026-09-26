const ts = () => new Date().toISOString().slice(11, 19);

export const log = {
  info: (scope: string, ...a: unknown[]) => console.log(`${ts()} [${scope}]`, ...a),
  warn: (scope: string, ...a: unknown[]) => console.warn(`${ts()} [${scope}] WARN`, ...a),
  error: (scope: string, ...a: unknown[]) => console.error(`${ts()} [${scope}] ERROR`, ...a),
};

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
