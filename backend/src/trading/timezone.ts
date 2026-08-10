export const TRADING_TIME_ZONE = "America/Matamoros";

const DATE_PARTS_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function datePartsFormatter(timeZone: string) {
  const cached = DATE_PARTS_FORMATTER_CACHE.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  DATE_PARTS_FORMATTER_CACHE.set(timeZone, formatter);
  return formatter;
}

function partsFor(date: Date, timeZone: string) {
  const parts = datePartsFormatter(timeZone).formatToParts(date);
  const record: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") record[part.type] = Number(part.value);
  }
  return {
    year: record.year,
    month: record.month,
    day: record.day,
    hour: record.hour === 24 ? 0 : record.hour,
    minute: record.minute,
    second: record.second
  };
}

export function tradingLocalDate(date = new Date()) {
  return date.toLocaleDateString("en-CA", { timeZone: TRADING_TIME_ZONE });
}

export function addDaysToLocalDate(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  const yyyy = utc.getUTCFullYear();
  const mm = String(utc.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(utc.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function timeZoneOffsetMs(date: Date, timeZone = TRADING_TIME_ZONE) {
  const parts = partsFor(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

export function zonedLocalDateTimeToUtcIso(localDateTime: string, timeZone = TRADING_TIME_ZONE) {
  const match = localDateTime.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) throw new Error("local_datetime_invalid");
  const [, y, mo, d, h, mi, s] = match;
  const localAsUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s || "0"));
  let utcMs = localAsUtc - timeZoneOffsetMs(new Date(localAsUtc), timeZone);
  utcMs = localAsUtc - timeZoneOffsetMs(new Date(utcMs), timeZone);
  return new Date(utcMs).toISOString();
}

export function tradingLocalDateWindow(date?: string) {
  const selectedDate = date || tradingLocalDate();
  const nextDate = addDaysToLocalDate(selectedDate, 1);
  return {
    selectedDate,
    start: zonedLocalDateTimeToUtcIso(`${selectedDate}T00:00:00`),
    end: zonedLocalDateTimeToUtcIso(`${nextDate}T00:00:00`)
  };
}

export function addMinutesIso(timestamp: string | null | undefined, minutes: number) {
  if (!timestamp) return null;
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getTime() + minutes * 60000).toISOString();
}

function closingWindowBounds(kickoffDate: Date) {
  const windowStartMs = kickoffDate.getTime() - 10 * 60000;
  const windowEndMs = kickoffDate.getTime() - 3 * 60000;
  return { windowStartMs, windowEndMs };
}

function minutesFromWindow(valueMs: number, windowStartMs: number, windowEndMs: number) {
  return valueMs < windowStartMs
    ? (valueMs - windowStartMs) / 60000
    : valueMs > windowEndMs
      ? (valueMs - windowEndMs) / 60000
      : 0;
}

function invalidClosingWindow(reason: string, whyInvalid: string) {
  return {
    closing_quality: reason,
    closing_window_start: null,
    closing_window_end: null,
    minutes_before_kickoff: null,
    minutes_from_valid_window: null,
    why_invalid: whyInvalid
  };
}

export function closingWindowDiagnostics(capturedAt: string, kickoff?: string | null) {
  const captured = new Date(capturedAt);
  const kickoffDate = kickoff ? new Date(kickoff) : null;
  if (!capturedAt || Number.isNaN(captured.getTime())) {
    return invalidClosingWindow("INVALID_CAPTURE_TIMESTAMP", "Invalid captured timestamp; stored for audit only.");
  }
  if (!kickoff) return invalidClosingWindow("MISSING_KICKOFF", "Missing kickoff timestamp; stored for audit only.");
  if (!kickoffDate || Number.isNaN(kickoffDate.getTime())) {
    return invalidClosingWindow("INVALID_KICKOFF_TIMESTAMP", "Invalid kickoff timestamp; stored for audit only.");
  }

  const { windowStartMs, windowEndMs } = closingWindowBounds(kickoffDate);
  const capturedMs = captured.getTime();
  const minutesBeforeKickoff = (kickoffDate.getTime() - capturedMs) / 60000;
  const minutesFromValidWindow = minutesFromWindow(capturedMs, windowStartMs, windowEndMs);

  if (capturedMs >= windowStartMs && capturedMs <= windowEndMs) {
    return {
      closing_quality: "CAPTURED_ON_TIME",
      closing_window_start: new Date(windowStartMs).toISOString(),
      closing_window_end: new Date(windowEndMs).toISOString(),
      minutes_before_kickoff: Number(minutesBeforeKickoff.toFixed(3)),
      minutes_from_valid_window: 0,
      why_invalid: null
    };
  }

  const early = capturedMs < windowStartMs;
  const minutesText = Math.abs(minutesFromValidWindow).toFixed(2);
  return {
    closing_quality: early ? "CAPTURED_TOO_EARLY" : "CAPTURED_LATE",
    closing_window_start: new Date(windowStartMs).toISOString(),
    closing_window_end: new Date(windowEndMs).toISOString(),
    minutes_before_kickoff: Number(minutesBeforeKickoff.toFixed(3)),
    minutes_from_valid_window: Number(minutesFromValidWindow.toFixed(3)),
    why_invalid: early
      ? `Captured ${minutesText} minutes before valid closing window.`
      : `Captured ${minutesText} minutes after valid closing window.`
  };
}

export function closingWindowStatusNow(kickoff?: string | null, now = new Date()) {
  const kickoffDate = kickoff ? new Date(kickoff) : null;
  if (!kickoff || !kickoffDate || Number.isNaN(kickoffDate.getTime()) || Number.isNaN(now.getTime())) {
    return {
      current_status: "WAITING_WINDOW",
      minutes_until_kickoff: null,
      valid_window: { start: null, end: null },
      minutes_from_valid_window: null
    };
  }

  const { windowStartMs, windowEndMs } = closingWindowBounds(kickoffDate);
  const nowMs = now.getTime();
  const minutesUntilKickoff = (kickoffDate.getTime() - nowMs) / 60000;
  const minutesFromValidWindow = minutesFromWindow(nowMs, windowStartMs, windowEndMs);
  const currentStatus = nowMs >= windowStartMs && nowMs <= windowEndMs
    ? "IN_VALID_CLOSING_WINDOW"
    : nowMs > windowEndMs
      ? "MISSED_WINDOW"
      : "WAITING_WINDOW";

  return {
    current_status: currentStatus,
    minutes_until_kickoff: Number(minutesUntilKickoff.toFixed(3)),
    valid_window: {
      start: new Date(windowStartMs).toISOString(),
      end: new Date(windowEndMs).toISOString()
    },
    minutes_from_valid_window: Number(minutesFromValidWindow.toFixed(3))
  };
}
