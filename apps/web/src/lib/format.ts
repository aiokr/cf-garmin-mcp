export function numeric(value: unknown, digits = 0): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString("zh-CN", { maximumFractionDigits: digits })
    : "—";
}
export function duration(seconds: number | null): string {
  if (seconds === null) return "—";
  const n = Math.round(seconds);
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  return h ? `${h}小时 ${m}分` : `${m}分 ${n % 60}秒`;
}
export function pace(speed: number | null): string {
  if (speed === null || speed <= 0) return "—";
  const seconds = Math.round(1000 / speed);
  return `${Math.floor(seconds / 60)}′${String(seconds % 60).padStart(2, "0")}″`;
}
export const sportName = (type: string) =>
  ({
    running: "跑步",
    cycling: "骑行",
    walking: "步行",
    hiking: "徒步",
    swimming: "游泳",
    strength_training: "力量训练",
    treadmill_running: "跑步机",
    indoor_cycling: "室内骑行",
  })[type] || type;
