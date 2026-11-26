import { ServiceError } from "../../lib/errors";

export async function readBytes(
  response: Response,
  limit = 8 * 1024 * 1024,
): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(response.headers.get("Content-Length")) > limit) {
    await response.body?.cancel();
    throw new ServiceError("UPSTREAM_RESPONSE_TOO_LARGE", 502);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new ServiceError("UPSTREAM_RESPONSE_TOO_LARGE", 502);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export async function jsonBody<T>(response: Response): Promise<T> {
  try {
    return JSON.parse(new TextDecoder().decode(await readBytes(response))) as T;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError("INVALID_UPSTREAM_RESPONSE", 502);
  }
}
export async function upstream(
  url: URL | string,
  init: RequestInit = {},
  attempts = 2,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      if (attempt < attempts) {
        await delay(250 * 2 ** attempt + Math.random() * 100);
        continue;
      }
      throw new ServiceError("UPSTREAM_NETWORK_ERROR", 502);
    }
    if (response.ok) return response;
    const status = response.status;
    const retryValue = response.headers.get("Retry-After");
    const seconds = retryValue
      ? /^\d+$/.test(retryValue)
        ? Number(retryValue)
        : Math.ceil((Date.parse(retryValue) - Date.now()) / 1000)
      : 60;
    await response.body?.cancel();
    if (status >= 500 && attempt < attempts) {
      await delay(250 * 2 ** attempt + Math.random() * 100);
      continue;
    }
    if (status === 429)
      throw new ServiceError(
        "UPSTREAM_RATE_LIMITED",
        429,
        Math.max(1, Math.min(Number.isFinite(seconds) ? seconds : 60, 86_400)),
      );
    if (status === 401) throw new ServiceError("PROVIDER_UNAUTHORIZED", 401);
    if (status === 403) throw new ServiceError("PROVIDER_BLOCKED", 403);
    if (status === 404 || status === 204)
      throw new ServiceError("PROVIDER_DATA_UNAVAILABLE", 404);
    throw new ServiceError(
      status >= 500 ? "UPSTREAM_UNAVAILABLE" : "UPSTREAM_REJECTED",
      502,
    );
  }
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
