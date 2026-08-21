import type { DurationInput } from "./types";

const MULTIPLIERS = {
  s: 1,
  m: 60,
  h: 60 * 60,
  d: 24 * 60 * 60,
} as const;

export function durationToSeconds(value: DurationInput): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error("Duration must be a positive integer number of seconds");
    }

    return value;
  }

  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) {
    throw new Error("Duration must look like 30s, 5m, 2h, or 1d");
  }

  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof MULTIPLIERS;
  const seconds = amount * MULTIPLIERS[unit];

  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new Error("Duration is outside the supported range");
  }

  return seconds;
}
