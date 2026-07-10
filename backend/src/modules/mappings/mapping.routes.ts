import { FastifyInstance } from "fastify";
import { z } from "zod";
import { redis } from "../../cache/redis.js";
import { db } from "../../db/index.js";
import { AppError } from "../../shared/http-errors.js";

const mappingParamsSchema = z.object({
  provider: z.string().min(1).max(80),
  eventId: z.string().min(1).max(180)
});

const mappingBodySchema = z.object({
  hub_match_id: z.string().uuid(),
  provider_name: z.string().min(1).max(80),
  provider_event_id: z.string().min(1).max(180),
  home_team_name: z.string().min(1).max(255),
  away_team_name: z.string().min(1).max(255),
  kickoff: z.string().datetime({ offset: true }),
  is_active: z.boolean().default(true),
  raw_data: z.record(z.unknown()).default({})
});

const mappingQuerySchema = z.object({
  max_kickoff_drift_minutes: z.coerce.number().int().positive().max(24 * 60).default(30)
});

const unmappedQuerySchema = z.object({
  provider: z.string().min(1).max(80).optional(),
  hours_back: z.coerce.number().int().min(0).max(168).default(2),
  hours_ahead: z.coerce.number().int().min(1).max(720).default(72),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

const rawProviderEventSchema = z.object({
  provider_name: z.string().min(1).max(80),
  provider_event_id: z.string().min(1).max(180),
  league_name: z.string().max(255).optional().nullable(),
  home_team_name: z.string().min(1).max(255),
  away_team_name: z.string().min(1).max(255),
  kickoff: z.string().datetime({ offset: true }),
  raw_data: z.record(z.unknown()).default({})
});

const rawProviderEventBatchSchema = z.object({
  events: z.array(rawProviderEventSchema).min(1).max(500)
});

function cacheKey(providerName: string, providerEventId: string) {
  return `provider_event_mapping:${providerName}:${providerEventId}`;
}

export async function mappingRoutes(app: FastifyInstance) {
  app.get("/api/v1/internal/mappings/unmapped", async (request) => {
    const query = unmappedQuerySchema.parse(request.query);
    const values: Array<string | number> = [query.hours_back, query.hours_ahead, query.limit];
    const providerFilter = query.provider
      ? `AND r.provider_name = $${values.push(query.provider)}`
      : "";

    const result = await db.query(
      `
        SELECT
          r.provider_name,
          r.provider_event_id,
          r.league_name,
          r.home_team_name,
          r.away_team_name,
          r.kickoff,
          r.first_seen_at,
          r.last_seen_at,
          r.raw_data
        FROM raw_provider_events r
        LEFT JOIN provider_event_mappings m
          ON m.provider_name = r.provider_name
         AND m.provider_event_id = r.provider_event_id
         AND m.is_active = TRUE
        WHERE m.hub_match_id IS NULL
          AND r.status = 'pending_mapping'
          AND r.kickoff >= NOW() - ($1::int * INTERVAL '1 hour')
          AND r.kickoff <= NOW() + ($2::int * INTERVAL '1 hour')
          ${providerFilter}
        ORDER BY r.kickoff ASC
        LIMIT $3;
      `,
      values
    );

    return {
      count: result.rows.length,
      events: result.rows
    };
  });

  app.post("/api/v1/internal/mappings/raw-events", async (request, reply) => {
    const body = rawProviderEventBatchSchema.parse(request.body);
    let inserted = 0;
    let updated = 0;

    for (const event of body.events) {
      const result = await db.query(
        `
          INSERT INTO raw_provider_events (
            provider_name, provider_event_id, league_name, home_team_name,
            away_team_name, kickoff, raw_data, status, first_seen_at, last_seen_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_mapping', NOW(), NOW())
          ON CONFLICT (provider_name, provider_event_id)
          DO UPDATE SET
            league_name = EXCLUDED.league_name,
            home_team_name = EXCLUDED.home_team_name,
            away_team_name = EXCLUDED.away_team_name,
            kickoff = EXCLUDED.kickoff,
            raw_data = EXCLUDED.raw_data,
            status = 'pending_mapping',
            last_seen_at = NOW()
          RETURNING (xmax = 0) AS inserted;
        `,
        [
          event.provider_name,
          event.provider_event_id,
          event.league_name ?? null,
          event.home_team_name,
          event.away_team_name,
          event.kickoff,
          event.raw_data
        ]
      );
      if (result.rows[0]?.inserted) {
        inserted += 1;
      } else {
        updated += 1;
      }
    }

    return reply.status(inserted ? 201 : 200).send({
      status: "success",
      received: body.events.length,
      inserted,
      updated
    });
  });

  app.get<{ Params: { provider: string; eventId: string } }>(
    "/api/v1/internal/mappings/:provider/:eventId",
    async (request) => {
      const params = mappingParamsSchema.parse(request.params);
      const query = mappingQuerySchema.parse(request.query);
      const key = cacheKey(params.provider, params.eventId);
      const cached = await redis.get(key);
      if (cached) {
        return JSON.parse(cached);
      }

      const result = await db.query(
        `
          SELECT
            pem.id,
            pem.hub_match_id,
            pem.provider_name,
            pem.provider_event_id,
            pem.home_team_name,
            pem.away_team_name,
            pem.kickoff,
            pem.is_active,
            pem.last_verified,
            ABS(EXTRACT(EPOCH FROM (m.match_date - pem.kickoff))) / 60 AS kickoff_drift_minutes
          FROM provider_event_mappings pem
          JOIN matches m ON m.id = pem.hub_match_id
          WHERE pem.provider_name = $1
            AND pem.provider_event_id = $2
            AND pem.is_active = TRUE
          LIMIT 1;
        `,
        [params.provider, params.eventId]
      );

      const row = result.rows[0];
      if (!row) {
        throw new AppError(404, "Mapping de proveedor no encontrado");
      }
      const kickoffDrift = Number(row.kickoff_drift_minutes ?? 0);
      if (kickoffDrift > query.max_kickoff_drift_minutes) {
        throw new AppError(409, "Mapping encontrado, pero el kickoff ya no coincide con la ventana permitida");
      }

      const payload = {
        id: row.id,
        hub_match_id: row.hub_match_id,
        provider_name: row.provider_name,
        provider_event_id: row.provider_event_id,
        home_team_name: row.home_team_name,
        away_team_name: row.away_team_name,
        kickoff: row.kickoff,
        is_active: row.is_active,
        last_verified: row.last_verified,
        kickoff_drift_minutes: kickoffDrift
      };
      await redis.set(key, JSON.stringify(payload), "EX", 300);
      return payload;
    }
  );

  app.post("/api/v1/internal/mappings", async (request, reply) => {
    const body = mappingBodySchema.parse(request.body);
    const result = await db.query(
      `
        INSERT INTO provider_event_mappings (
          hub_match_id, provider_name, provider_event_id, home_team_name,
          away_team_name, kickoff, is_active, raw_data, last_verified
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        ON CONFLICT (provider_name, provider_event_id)
        DO UPDATE SET
          hub_match_id = EXCLUDED.hub_match_id,
          home_team_name = EXCLUDED.home_team_name,
          away_team_name = EXCLUDED.away_team_name,
          kickoff = EXCLUDED.kickoff,
          is_active = EXCLUDED.is_active,
          raw_data = EXCLUDED.raw_data,
          last_verified = NOW()
        RETURNING *;
      `,
      [
        body.hub_match_id,
        body.provider_name,
        body.provider_event_id,
        body.home_team_name,
        body.away_team_name,
        body.kickoff,
        body.is_active,
        body.raw_data
      ]
    );

    await redis.del(cacheKey(body.provider_name, body.provider_event_id));
    await db.query(
      `
        UPDATE raw_provider_events
        SET status = 'mapped', last_seen_at = NOW()
        WHERE provider_name = $1 AND provider_event_id = $2;
      `,
      [body.provider_name, body.provider_event_id]
    );
    return reply.status(201).send(result.rows[0]);
  });
}
