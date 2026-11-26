import { FitEncoder, FitBaseType } from "fit-file-parser";

// Entirely synthetic activity; no real health data or GPS trace is in this repo.
export function syntheticFit(): Uint8Array<ArrayBuffer> {
  const encoder = new FitEncoder();
  const start = FitEncoder.toFitTimestamp(new Date("2026-11-26T00:00:00Z"));
  for (let index = 0; index < 3; index++)
    encoder.writeMessage(20, [
      {
        number: 253,
        size: 4,
        baseType: FitBaseType.Uint32,
        value: start + index * 10,
      },
      {
        number: 0,
        size: 4,
        baseType: FitBaseType.Sint32,
        value: Math.round(((30 + index * 0.001) * 2147483648) / 180),
      },
      {
        number: 1,
        size: 4,
        baseType: FitBaseType.Sint32,
        value: Math.round(((120 + index * 0.001) * 2147483648) / 180),
      },
      { number: 3, size: 1, baseType: FitBaseType.Uint8, value: 120 + index },
      {
        number: 5,
        size: 4,
        baseType: FitBaseType.Uint32,
        value: index * 10000,
      },
      { number: 6, size: 2, baseType: FitBaseType.Uint16, value: 3000 },
    ]);
  encoder.writeMessage(
    19,
    [
      { number: 8, size: 4, baseType: FitBaseType.Uint32, value: 20000 },
      { number: 9, size: 4, baseType: FitBaseType.Uint32, value: 20000 },
      { number: 13, size: 2, baseType: FitBaseType.Uint16, value: 3000 },
      { number: 15, size: 1, baseType: FitBaseType.Uint8, value: 121 },
    ],
    1,
  );
  return new Uint8Array(encoder.close());
}
