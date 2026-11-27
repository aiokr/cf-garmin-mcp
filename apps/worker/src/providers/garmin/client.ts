import type { Env } from "../../env";
import { GARMIN_HOSTS } from "./config";
import { type Tokens, type Region, NATIVE_HEADERS, personalBase } from "./auth";
import { upstream, jsonBody, readBytes } from "./http";
import { ServiceError } from "../../lib/errors";

export type ProviderOperation =
  | "profile"
  | "activities"
  | "activity"
  | "health"
  | "sleep"
  | "hrv"
  | "training"
  | "vo2max"
  | "readiness"
  | "devices"
  | "records"
  | "file";
export type ProviderQuery = {
  date?: string;
  endDate?: string;
  start?: number;
  limit?: number;
  id?: string;
  displayName?: string;
};
export async function providerRequest(
  env: Env,
  tokens: Tokens,
  operation: ProviderOperation,
  query: ProviderQuery = {},
): Promise<unknown> {
  const region = env.GARMIN_REGION as Region;
  const base =
    env.GARMIN_AUTH_MODE === "personal_api"
      ? personalBase(region)
      : GARMIN_HOSTS[region].connect;
  const user = encodeURIComponent(query.displayName || "");
  const date = encodeURIComponent(query.date || "");
  const id = encodeURIComponent(query.id || "");
  const paths: Record<ProviderOperation, string> = {
    // Personal API exposes account settings rather than the mobile social profile.
    profile:
      env.GARMIN_AUTH_MODE === "personal_api"
        ? "/userprofile-service/userprofile/settings"
        : "/userprofile-service/socialProfile",
    activities: "/activitylist-service/activities/search/activities",
    activity: `/activity-service/activity/${id}`,
    health:
      env.GARMIN_AUTH_MODE === "personal_api"
        ? "/usersummary-service/usersummary/daily"
        : `/usersummary-service/usersummary/daily/${user}`,
    sleep:
      env.GARMIN_AUTH_MODE === "personal_api"
        ? "/sleep-service/sleep/dailySleepSummariesByDate"
        : `/wellness-service/wellness/dailySleepData/${user}`,
    hrv: `/hrv-service/hrv/${date}`,
    training: `/metrics-service/metrics/trainingstatus/aggregated/${date}`,
    vo2max: `/metrics-service/metrics/maxmet/daily/${date}/${date}`,
    readiness: `/metrics-service/metrics/trainingreadiness/${date}`,
    devices: "/device-service/deviceregistration/devices",
    records: `/personalrecord-service/personalrecord/prs/${user}`,
    file: `/download-service/files/activity/${id}`,
  };
  if (!paths[operation]) throw new ServiceError("INVALID_PROVIDER_OPERATION");
  const url = new URL(base + paths[operation]);
  if (operation === "activities") {
    url.searchParams.set("start", String(query.start || 0));
    url.searchParams.set("limit", String(Math.min(query.limit || 50, 100)));
    url.searchParams.set("sortOrder", "desc");
    url.searchParams.set("excludeChildren", "true");
    if (query.date) url.searchParams.set("startDate", query.date);
    if (query.endDate) url.searchParams.set("endDate", query.endDate);
  }
  if (operation === "health")
    url.searchParams.set("calendarDate", query.date || "");
  if (operation === "sleep" && env.GARMIN_AUTH_MODE === "personal_api") {
    url.searchParams.set("startDate", query.date || "");
    url.searchParams.set("endDate", query.date || "");
  } else if (operation === "sleep") {
    url.searchParams.set("date", query.date || "");
    url.searchParams.set("nonSleepBufferMinutes", "60");
  }
  const response = await upstream(url, {
    headers: {
      ...(env.GARMIN_AUTH_MODE === "personal_api" ? {} : NATIVE_HEADERS),
      Authorization: `Bearer ${tokens.accessToken}`,
      Accept: operation === "file" ? "*/*" : "application/json",
    },
  });
  if (operation === "file")
    return readBytes(
      response,
      Math.min(Number(env.MAX_FIT_BYTES) || 16_777_216, 33_554_432),
    );
  if (response.status === 204)
    throw new ServiceError("PROVIDER_DATA_UNAVAILABLE", 404);
  return jsonBody(response);
}
export async function identity(
  env: Env,
  tokens: Tokens,
): Promise<{ id: string; displayName: string; name: string }> {
  const profile = (await providerRequest(env, tokens, "profile")) as Record<
    string,
    unknown
  >;
  // Settings may omit the numeric profile ID. Keep a deterministic account
  // identity for reauthentication checks; locale alone cannot identify an account.
  const id =
    profile.profileId ??
    profile.id ??
    profile.userProfilePk ??
    (env.GARMIN_AUTH_MODE === "personal_api" &&
    typeof profile.displayName === "string" &&
    profile.displayName.trim()
      ? `personal:${profile.displayName}`
      : undefined);
  if (
    (typeof id !== "string" && typeof id !== "number") ||
    !String(id) ||
    typeof profile.displayName !== "string" ||
    !profile.displayName.trim()
  )
    throw new ServiceError("INVALID_PROVIDER_IDENTITY", 502);
  return {
    id: String(id),
    displayName: profile.displayName,
    name:
      typeof profile.fullName === "string"
        ? profile.fullName
        : profile.displayName,
  };
}
