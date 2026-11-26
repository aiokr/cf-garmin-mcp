import type {
  ApiErrorBody,
  ApiResponse,
} from "../../../../packages/shared/src";

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public requestId?: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const body = (await response.json()) as ApiResponse<T> &
    Partial<ApiErrorBody> & { message?: string; code?: string };
  if (!response.ok)
    throw new ApiError(
      body.error?.code || body.code || "REQUEST_FAILED",
      body.error?.message || body.message || "请求失败，请稍后重试。",
      body.requestId,
    );
  return body.data;
}
