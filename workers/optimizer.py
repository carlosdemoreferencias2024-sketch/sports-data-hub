import argparse
import os
from dataclasses import dataclass
from decimal import Decimal

import psycopg


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgres://sports_admin:replace_with_local_postgres_password@localhost:5433/sports_db",
)


@dataclass(frozen=True)
class PerformanceSummary:
    model_name: str
    sport_slug: str | None
    sample_size: int
    brier_score: float
    accuracy: float
    bias_home: float
    avg_predicted_home: float
    avg_actual_home: float


def _to_float(value) -> float:
    if isinstance(value, Decimal):
        return float(value)
    return float(value)


def fetch_prediction_results(
    conn,
    model_name: str,
    max_age_days: int | None,
    sport_slug: str | None,
) -> list[dict]:
    params: list[object] = [model_name]
    age_filter = ""
    if max_age_days is not None:
        age_filter = "AND mq.generated_at >= NOW() - (%s * INTERVAL '1 day')"
        params.append(max_age_days)
    sport_filter = ""
    if sport_slug:
        sport_filter = "AND (s.slug = %s OR l.slug = %s OR CONCAT(s.slug, '/', l.slug) = %s)"
        params.extend([sport_slug, sport_slug])
        params.append(sport_slug)

    rows = conn.execute(
        f"""
        WITH latest_model_quotes AS (
          SELECT DISTINCT ON (mq.match_id)
            mq.match_id,
            mq.model_name,
            mq.home_probability,
            mq.generated_at,
            m.league_id,
            m.slug,
            home_comp.team_id AS home_team_id,
            away_comp.team_id AS away_team_id
          FROM model_quotes mq
          JOIN matches m ON m.id = mq.match_id
          JOIN match_competitors home_comp
            ON home_comp.match_id = m.id
           AND home_comp.home_away = 'home'
          JOIN match_competitors away_comp
            ON away_comp.match_id = m.id
           AND away_comp.home_away = 'away'
          JOIN leagues l ON l.id = m.league_id
          JOIN sports s ON s.id = l.sport_id
          WHERE mq.model_name = %s
            AND mq.market_type IN ('moneyline_2way', 'moneyline_3way')
            {age_filter}
            {sport_filter}
          ORDER BY mq.match_id, mq.generated_at DESC
        )
        SELECT
          lmq.match_id,
          lmq.home_probability,
          lmq.generated_at,
          settlement_match.home_score,
          settlement_match.away_score,
          lmq.slug
        FROM latest_model_quotes lmq
        JOIN LATERAL (
          SELECT fm.id, fm.home_score, fm.away_score
          FROM matches fm
          JOIN match_competitors final_home
            ON final_home.match_id = fm.id
           AND final_home.home_away = 'home'
           AND final_home.team_id = lmq.home_team_id
          JOIN match_competitors final_away
            ON final_away.match_id = fm.id
           AND final_away.home_away = 'away'
           AND final_away.team_id = lmq.away_team_id
          WHERE fm.league_id = lmq.league_id
            AND fm.status = 'finished'
            AND fm.home_score IS NOT NULL
            AND fm.away_score IS NOT NULL
            AND ABS(EXTRACT(EPOCH FROM (fm.match_date - (SELECT match_date FROM matches WHERE id = lmq.match_id)))) <= 60 * 60 * 24 * 14
          ORDER BY
            CASE WHEN fm.id = lmq.match_id THEN 0 ELSE 1 END,
            fm.match_date DESC,
            fm.updated_at DESC
          LIMIT 1
        ) settlement_match ON TRUE
        ORDER BY lmq.generated_at DESC;
        """,
        params,
    ).fetchall()

    return [
        {
            "match_id": row[0],
            "home_probability": _to_float(row[1]),
            "generated_at": row[2],
            "home_score": int(row[3]),
            "away_score": int(row[4]),
            "slug": row[5],
        }
        for row in rows
    ]


def analyze(
    model_name: str,
    max_age_days: int | None = None,
    sport_slug: str | None = None,
) -> PerformanceSummary:
    with psycopg.connect(DATABASE_URL) as conn:
        rows = fetch_prediction_results(conn, model_name, max_age_days, sport_slug)

    if not rows:
        return PerformanceSummary(
            model_name=model_name,
            sport_slug=sport_slug,
            sample_size=0,
            brier_score=0.0,
            accuracy=0.0,
            bias_home=0.0,
            avg_predicted_home=0.0,
            avg_actual_home=0.0,
        )

    brier_total = 0.0
    correct = 0
    predicted_home_total = 0.0
    actual_home_total = 0.0
    for row in rows:
        predicted_home = row["home_probability"]
        actual_home = 1.0 if row["home_score"] > row["away_score"] else 0.0
        brier_total += (predicted_home - actual_home) ** 2
        predicted_pick_home = predicted_home >= 0.5
        actual_pick_home = actual_home == 1.0
        if predicted_pick_home == actual_pick_home:
            correct += 1
        predicted_home_total += predicted_home
        actual_home_total += actual_home

    sample_size = len(rows)
    avg_predicted_home = predicted_home_total / sample_size
    avg_actual_home = actual_home_total / sample_size
    return PerformanceSummary(
        model_name=model_name,
        sport_slug=sport_slug,
        sample_size=sample_size,
        brier_score=brier_total / sample_size,
        accuracy=correct / sample_size,
        bias_home=avg_predicted_home - avg_actual_home,
        avg_predicted_home=avg_predicted_home,
        avg_actual_home=avg_actual_home,
    )


def suggestion_for(summary: PerformanceSummary) -> str:
    if summary.sample_size < 10:
        return "Muestra pequena: observa mas partidos antes de ajustar pesos."
    if summary.brier_score >= 0.25:
        return "Brier alto: baja agresividad del modelo y revisa pesos de pitching/ofensiva."
    if summary.bias_home > 0.05:
        return "Sesgo local positivo: reduce home_field_weight o exige mas evidencia local."
    if summary.bias_home < -0.05:
        return "Sesgo local negativo: sube ligeramente home_field_weight o revisa stats visitantes."
    return "Modelo estable: no se sugieren cambios inmediatos."


def persist_summary(summary: PerformanceSummary, notes: str) -> None:
    with psycopg.connect(DATABASE_URL) as conn:
        conn.execute(
            """
            INSERT INTO model_parameters (
              model_name, brier_score, sample_size, accuracy, bias_home, notes
            )
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (model_name) WHERE is_active = TRUE
            DO UPDATE SET
              brier_score = EXCLUDED.brier_score,
              sample_size = EXCLUDED.sample_size,
              accuracy = EXCLUDED.accuracy,
              bias_home = EXCLUDED.bias_home,
              notes = EXCLUDED.notes,
              updated_at = NOW();
            """,
            (
                summary.model_name,
                round(summary.brier_score, 6),
                summary.sample_size,
                round(summary.accuracy, 4),
                round(summary.bias_home, 4),
                notes,
            ),
        )
        conn.commit()


def print_summary(summary: PerformanceSummary, dry_run: bool) -> None:
    notes = suggestion_for(summary)
    print(f"--- ANALISIS DE RENDIMIENTO: {summary.model_name} ---")
    if summary.sport_slug:
        print(f"Deporte: {summary.sport_slug}")
    print(f"Muestra: {summary.sample_size} partidos")
    print(f"Accuracy: {summary.accuracy:.2%}")
    print(f"Brier Score: {summary.brier_score:.4f} (menor es mejor)")
    print(f"Bias Local: {summary.bias_home:+.4f}")
    print(f"Promedio predicho local: {summary.avg_predicted_home:.2%}")
    print(f"Promedio real local: {summary.avg_actual_home:.2%}")
    print(f"Sugerencia: {notes}")
    print(f"dry_run={dry_run}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Analiza model_quotes contra resultados finales.")
    parser.add_argument("--model-name", default="carlos_v1_mlb")
    parser.add_argument("--sport", default=None)
    parser.add_argument("--max-age-days", type=int, default=None)
    parser.add_argument("--min-sample-to-persist", type=int, default=50)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    summary = analyze(args.model_name, args.max_age_days, args.sport)
    print_summary(summary, args.dry_run)
    if not args.dry_run and summary.sample_size >= args.min_sample_to_persist:
        persist_summary(summary, suggestion_for(summary))
        print("[+] model_parameters actualizado.")
    elif not args.dry_run:
        print(
            "[!] model_parameters no actualizado: "
            f"sample_size={summary.sample_size} < min_sample_to_persist={args.min_sample_to_persist}"
        )


if __name__ == "__main__":
    main()
