export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
export const firstObject = (value: unknown) =>
  object(Array.isArray(value) ? value[0] : value);
export const nested = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((current, key) => object(current)[key], value);
export const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value.slice(0, 500) : fallback;

export function mapActivity(raw: unknown, timezone = "UTC") {
  const value = object(raw);
  const summary = object(value.summaryDTO);
  const id = value.activityId;
  if (!/^\d{1,24}$/.test(String(id))) return null;
  const timestamp = text(value.startTimeGMT || summary.startTimeGMT);
  const time = Date.parse(
    timestamp.replace(" ", "T") +
      (/[zZ]|[+-]\d\d:\d\d$/.test(timestamp) ? "" : "Z"),
  );
  if (!Number.isFinite(time)) return null;
  const local =
    text(value.startTimeLocal).slice(0, 10) ||
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(
      new Date(time),
    );
  return {
    external_activity_id: String(id),
    sport_type: text(nested(value.activityType, "typeKey"), "other"),
    name: text(value.activityName, "未命名运动"),
    start_time_utc: new Date(time).toISOString(),
    local_date: local,
    duration_s: number(value.duration ?? summary.duration),
    moving_s: number(value.movingDuration ?? summary.movingDuration),
    distance_m: number(value.distance ?? summary.distance),
    avg_hr: number(value.averageHR ?? summary.averageHR),
    max_hr: number(value.maxHR ?? summary.maxHR),
    avg_speed_mps: number(value.averageSpeed ?? summary.averageSpeed),
    avg_cadence: number(
      value.averageRunningCadenceInStepsPerMinute ??
        value.averageBikingCadenceInRevPerMinute,
    ),
    avg_power_w: number(value.averagePower ?? summary.averagePower),
    elevation_gain_m: number(value.elevationGain ?? summary.elevationGain),
    calories_kcal: number(value.calories ?? summary.calories),
  };
}
export type Activity = NonNullable<ReturnType<typeof mapActivity>> & {
  id: string;
  connection_id: string;
  synced_at: string;
  source: string;
};

const nonNegative = (value: unknown): number | null => {
  const result = number(value);
  return result !== null && result >= 0 ? result : null;
};

export function mapHealth(summary: unknown, sleep: unknown, hrv: unknown) {
  const daily = object(summary);
  const sleeping = Array.isArray(sleep)
    ? firstObject(sleep)
    : object(nested(sleep, "dailySleepDTO"));
  const hr = object(nested(hrv, "hrvSummary"));
  return {
    steps: nonNegative(daily.totalSteps),
    resting_hr: nonNegative(daily.restingHeartRate),
    sleep_seconds: nonNegative(sleeping.sleepTimeSeconds),
    sleep_score: nonNegative(
      nested(sleeping, "sleepScores", "overall", "value"),
    ),
    hrv: nonNegative(hr.lastNightAvg),
    stress: nonNegative(daily.averageStressLevel),
    body_battery: nonNegative(daily.bodyBatteryHighestValue),
    distance_m: nonNegative(daily.totalDistanceMeters),
  };
}
export function mapTraining(status: unknown, vo2: unknown, readiness: unknown) {
  const metrics = firstObject(vo2);
  const ready = firstObject(readiness);
  const values = object(
    nested(status, "mostRecentTrainingStatus", "latestTrainingStatusData"),
  );
  const training = firstObject(Object.values(values));
  return {
    vo2max: nonNegative(
      nested(metrics, "generic", "vo2MaxPreciseValue") ??
        nested(metrics, "generic", "vo2MaxValue") ??
        metrics.vo2MaxValue,
    ),
    readiness: nonNegative(ready.score),
    training_load: nonNegative(
      nested(training, "acuteTrainingLoadDTO", "dailyTrainingLoadAcute") ??
        training.weeklyTrainingLoad,
    ),
    training_status:
      text(training.trainingStatusFeedbackPhrase) ||
      (typeof training.trainingStatus === "number"
        ? String(training.trainingStatus)
        : null),
  };
}
