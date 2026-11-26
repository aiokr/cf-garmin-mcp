import FitParser from "fit-file-parser";
import { unzipSync } from "fflate";
import { ServiceError } from "../lib/errors";
import { number, object } from "../providers/garmin/mapper";

const MAX_BYTES = 32 * 1024 * 1024;
export function extractFit(
  input: Uint8Array<ArrayBuffer>,
  maxBytes = MAX_BYTES,
): Uint8Array<ArrayBuffer> {
  const limit = Math.min(Math.max(maxBytes || MAX_BYTES, 1), MAX_BYTES);
  if (input.length > limit) throw new ServiceError("FIT_TOO_LARGE", 413);
  if (input[0] === 0x50 && input[1] === 0x4b) {
    let selected = false;
    const files = unzipSync(input, {
      filter: (file) => {
        if (!/\.fit$/i.test(file.name) || selected) return false;
        if (
          file.originalSize > limit ||
          file.originalSize / Math.max(1, file.size) > 200
        )
          throw new ServiceError("FIT_ARCHIVE_LIMIT", 413);
        selected = true;
        return true;
      },
    });
    const fit = Object.values(files)[0];
    if (!fit) throw new ServiceError("FIT_MISSING_FROM_ARCHIVE", 502);
    if (fit.length > limit) throw new ServiceError("FIT_TOO_LARGE", 413);
    return new Uint8Array(fit);
  }
  return input;
}
type FitSample = {
  timestamp: string;
  distance_m: number | null;
  speed_mps: number | null;
  hr_bpm: number | null;
  cadence: number | null;
  power_w: number | null;
  elevation_m: number | null;
};
type FitLap = {
  index: number;
  duration_s: number | null;
  distance_m: number | null;
  avg_hr: number | null;
  avg_speed_mps: number | null;
  avg_power_w: number | null;
};
export type FitDetails = {
  samples: FitSample[];
  laps: FitLap[];
  track: [number, number][];
  sampleCount: number;
  missing: boolean;
};
const deg = (value: unknown, limit: number): number | null => {
  const n = number(value);
  if (n === null) return null;
  const d = Math.abs(n) <= limit ? n : (n * 180) / 2147483648;
  return Math.abs(d) <= limit ? d : null;
};

export async function parseFit(
  bytes: Uint8Array<ArrayBuffer>,
  maxPoints = 2000,
): Promise<FitDetails> {
  if (bytes.length > MAX_BYTES) throw new ServiceError("FIT_TOO_LARGE", 413);
  let parsed;
  try {
    parsed = await new FitParser({
      force: false,
      strict: true,
      mode: "list",
      speedUnit: "m/s",
      lengthUnit: "m",
    }).parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
  } catch {
    throw new ServiceError("FIT_INTEGRITY_FAILED", 502);
  }
  const records = (parsed.records || []) as unknown as Record<
    string,
    unknown
  >[];
  if (records.length > 200_000) throw new ServiceError("FIT_RECORD_LIMIT", 413);
  const stride = Math.max(1, Math.ceil(records.length / maxPoints));
  const samples: FitSample[] = [];
  const track: [number, number][] = [];
  for (let i = 0; i < records.length; i += stride) {
    const record = records[i]!;
    const time =
      record.timestamp instanceof Date ? record.timestamp.toISOString() : null;
    if (time)
      samples.push({
        timestamp: time,
        distance_m: number(record.distance),
        speed_mps: number(record.enhanced_speed ?? record.speed),
        hr_bpm: number(record.heart_rate),
        cadence: number(record.cadence),
        power_w: number(record.power),
        elevation_m: number(record.enhanced_altitude ?? record.altitude),
      });
    const lat = deg(record.position_lat, 90);
    const lon = deg(record.position_long, 180);
    if (lat !== null && lon !== null) track.push([lon, lat]);
  }
  const laps = ((parsed.laps || []) as unknown[])
    .slice(0, 1000)
    .map((raw, index): FitLap => {
      const lap = object(raw);
      return {
        index: index + 1,
        duration_s: number(lap.total_timer_time),
        distance_m: number(lap.total_distance),
        avg_hr: number(lap.avg_heart_rate),
        avg_speed_mps: number(lap.enhanced_avg_speed ?? lap.avg_speed),
        avg_power_w: number(lap.avg_power),
      };
    });
  return {
    samples,
    laps,
    track,
    sampleCount: records.length,
    missing: records.length === 0,
  };
}
