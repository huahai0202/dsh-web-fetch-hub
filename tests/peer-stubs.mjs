// Minimal peer contracts for standalone provider tests; no dsh installation needed.
export class WebError extends Error {
  constructor(message, code, options) { super(message, options); this.code = code }
}
export const launchEnvironmentOf = ctx => ctx.launchEnvironment ?? { get: () => undefined }
