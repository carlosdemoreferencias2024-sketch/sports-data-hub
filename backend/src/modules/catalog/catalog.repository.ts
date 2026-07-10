import { db } from "../../db/index.js";
import { ListLeaguesQuery, ListTeamsQuery } from "./catalog.schemas.js";

export class CatalogRepository {
  async listSports() {
    const result = await db.query(`
      SELECT id, slug, name, created_at, updated_at
      FROM sports
      ORDER BY name;
    `);
    return result.rows;
  }

  async listLeagues(query: ListLeaguesQuery) {
    const values: string[] = [];
    const filters: string[] = ["l.is_active = TRUE"];

    if (query.sport) {
      values.push(query.sport);
      filters.push(`s.slug = $${values.length}`);
    }

    const result = await db.query(
      `
        SELECT
          l.id,
          l.slug,
          l.name,
          l.abbreviation,
          l.country,
          l.logo_url,
          s.slug AS sport_slug,
          s.name AS sport_name
        FROM leagues l
        JOIN sports s ON s.id = l.sport_id
        WHERE ${filters.join(" AND ")}
        ORDER BY s.name, l.name;
      `,
      values
    );

    return result.rows;
  }

  async listTeams(query: ListTeamsQuery) {
    const values: string[] = [];
    const filters: string[] = ["t.is_active = TRUE"];

    if (query.league) {
      values.push(query.league);
      filters.push(`l.slug = $${values.length}`);
    }

    if (query.search) {
      values.push(`%${query.search}%`);
      filters.push(`(
        t.name ILIKE $${values.length}
        OR t.short_name ILIKE $${values.length}
        OR t.abbreviation ILIKE $${values.length}
      )`);
    }

    const result = await db.query(
      `
        SELECT
          t.id,
          t.slug,
          t.name,
          t.short_name,
          t.abbreviation,
          t.logo_url,
          t.venue_id,
          l.slug AS league_slug,
          s.slug AS sport_slug
        FROM teams t
        JOIN leagues l ON l.id = t.league_id
        JOIN sports s ON s.id = l.sport_id
        WHERE ${filters.join(" AND ")}
        ORDER BY t.name;
      `,
      values
    );

    return result.rows;
  }
}
