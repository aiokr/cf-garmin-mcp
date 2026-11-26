export class ServiceError extends Error {
  code: string;
  status: number;
  retryAfter: number;
  constructor(code: string, status = 400, retryAfter = 0) {
    super(code);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function safeCode(error: unknown): string {
  return error instanceof ServiceError ? error.code : "INTERNAL_ERROR";
}
