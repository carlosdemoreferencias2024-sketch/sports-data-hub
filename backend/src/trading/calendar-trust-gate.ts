export type CalendarValidationStatus =
  | "VALID"
  | "PLACEHOLDER_SCHEDULE"
  | "ID_MISMATCH"
  | "PENDING_CHECK"
  | "MISSING";

export type CalendarTrustInput = {
  matchId: string;
  providerEventId: string | null;
  kickoffAt: string | null;
  scheduleValidation: CalendarValidationStatus | string | null;
  identityValidation: CalendarValidationStatus | string | null;
};

export type CalendarTrustDecision = {
  trusted: boolean;
  reasons: string[];
};

type Queryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, any>[] }>;
};

function validationStatus(value: unknown): string {
  const normalized = String(value || "").trim().toUpperCase();
  return normalized || "MISSING";
}

export function evaluateCalendarTrust(input: CalendarTrustInput): CalendarTrustDecision {
  const reasons: string[] = [];
  if (!String(input.providerEventId || "").trim()) reasons.push("PROVIDER_EVENT_ID_MISSING");

  const kickoff = String(input.kickoffAt || "").trim();
  if (!kickoff) reasons.push("KICKOFF_MISSING");
  else if (Number.isNaN(Date.parse(kickoff))) reasons.push("KICKOFF_INVALID");

  const schedule = validationStatus(input.scheduleValidation);
  const identity = validationStatus(input.identityValidation);
  if (schedule !== "VALID") reasons.push(`SCHEDULE_NOT_VALID:${schedule}`);
  if (identity !== "VALID") reasons.push(`IDENTITY_NOT_VALID:${identity}`);

  return { trusted: reasons.length === 0, reasons };
}

export async function loadCalendarTrustDecisions(
  db: Queryable,
  matchIds: string[]
): Promise<Map<string, CalendarTrustDecision>> {
  const uniqueIds = [...new Set(matchIds.filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();

  const result = await db.query(
    `
      SELECT
        requested.match_id,
        COALESCE(fm.scheduled_start, base_match.match_date) AS kickoff_at,
        mapping.external_match_id AS provider_event_id,
        schedule.result AS schedule_validation,
        identity.result AS identity_validation
      FROM unnest($1::uuid[]) AS requested(match_id)
      LEFT JOIN forecast_matches fm ON fm.match_id = requested.match_id
      LEFT JOIN matches base_match ON base_match.id = requested.match_id
      LEFT JOIN LATERAL (
        SELECT external_match_id
        FROM forecast_provider_match_mappings
        WHERE match_id = requested.match_id
        ORDER BY verified_at DESC, id DESC
        LIMIT 1
      ) mapping ON TRUE
      LEFT JOIN LATERAL (
        SELECT result
        FROM forecast_slate_validations
        WHERE match_id = requested.match_id AND validation_type = 'schedule'
        ORDER BY validated_at DESC, id DESC
        LIMIT 1
      ) schedule ON TRUE
      LEFT JOIN LATERAL (
        SELECT result
        FROM forecast_slate_validations
        WHERE match_id = requested.match_id AND validation_type = 'identity'
        ORDER BY validated_at DESC, id DESC
        LIMIT 1
      ) identity ON TRUE
    `,
    [uniqueIds]
  );

  const decisions = new Map<string, CalendarTrustDecision>();
  for (const row of result.rows) {
    const matchId = String(row.match_id);
    decisions.set(matchId, evaluateCalendarTrust({
      matchId,
      providerEventId: row.provider_event_id ? String(row.provider_event_id) : null,
      kickoffAt: row.kickoff_at ? new Date(row.kickoff_at).toISOString() : null,
      scheduleValidation: row.schedule_validation,
      identityValidation: row.identity_validation
    }));
  }
  for (const matchId of uniqueIds) {
    if (!decisions.has(matchId)) {
      decisions.set(matchId, evaluateCalendarTrust({
        matchId,
        providerEventId: null,
        kickoffAt: null,
        scheduleValidation: "MISSING",
        identityValidation: "MISSING"
      }));
    }
  }
  return decisions;
}
