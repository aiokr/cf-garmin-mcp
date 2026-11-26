import { ServiceError } from "./errors.ts";
import type { Env } from "../env";

const encoder = new TextEncoder();
export function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}
export function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
export async function sha256(
  value: string | Uint8Array<ArrayBuffer>,
): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    typeof value === "string" ? encoder.encode(value) : value,
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
function keyFor(env: Env, version: number): string {
  const current = Number(env.PROVIDER_KEY_VERSION || 1);
  const key =
    version === current
      ? env.PROVIDER_ENCRYPTION_KEY
      : version === current - 1
        ? env.PROVIDER_ENCRYPTION_KEY_PREVIOUS
        : undefined;
  if (!key) throw new ServiceError("ENCRYPTION_KEY_UNAVAILABLE", 503);
  try {
    if (unbase64(key).length !== 32) throw new Error();
  } catch {
    throw new ServiceError("INVALID_ENCRYPTION_KEY", 503);
  }
  return key;
}
export type EncryptionContext = {
  userId: string;
  connectionId: string;
  region: string;
  purpose?: string;
};
const aad = (context: EncryptionContext, version: number) =>
  encoder.encode(
    JSON.stringify([
      context.userId,
      context.connectionId,
      "garmin",
      context.region,
      version,
      context.purpose || "tokens",
    ]),
  );
export async function seal(
  env: Env,
  context: EncryptionContext,
  value: unknown,
): Promise<string> {
  const version = Number(env.PROVIDER_KEY_VERSION || 1);
  const key = await crypto.subtle.importKey(
    "raw",
    unbase64(keyFor(env, version)),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(context, version) },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return JSON.stringify({
    version,
    iv: base64(iv),
    data: base64(new Uint8Array(bytes)),
  });
}
export async function open<T>(
  env: Env,
  context: EncryptionContext,
  envelope: string,
): Promise<T> {
  try {
    const payload = JSON.parse(envelope) as {
      version: number;
      iv: string;
      data: string;
    };
    const key = await crypto.subtle.importKey(
      "raw",
      unbase64(keyFor(env, payload.version)),
      "AES-GCM",
      false,
      ["decrypt"],
    );
    const bytes = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: unbase64(payload.iv),
        additionalData: aad(context, payload.version),
      },
      key,
      unbase64(payload.data),
    );
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError("TOKEN_DECRYPTION_FAILED", 503);
  }
}
export async function credentialFingerprint(env: Env): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.BETTER_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const source = JSON.stringify([
    env.GARMIN_AUTH_MODE,
    env.GARMIN_REGION,
    env.GARMIN_PERSONAL_API_KEY || "",
    env.GARMIN_EMAIL || "",
    env.GARMIN_PASSWORD || "",
  ]);
  return base64(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(source)),
    ),
  );
}
