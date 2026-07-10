import argparse
from datetime import datetime, timezone

from alpha_detector import detect_alpha
from data_fetcher import generate_autofilled_stats
from data_fetcher_football import fetch_football_features
from data_fetcher_nba import fetch_nba_features
from ingest_model_features import ingest_features
from ingest_stats import ingest_csv
from optimizer import analyze, persist_summary, print_summary, suggestion_for


def log(message: str) -> None:
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{timestamp}] {message}", flush=True)


def optimizer_sport_slug(sport: str) -> str:
    return {
        "football": "soccer",
        "mlb": "baseball",
        "nba": "basketball",
    }.get(sport, sport)


def run_pipeline(
    sport: str,
    model_name: str,
    output_path: str,
    lookback_games: int,
    league_slug: str,
    include_live: bool,
    dry_run: bool,
    skip_optimizer: bool,
    skip_alpha: bool,
    min_ev: float,
    compact_logs: bool,
    auto_paper: bool,
    stake_mode: str,
    flat_fraction: float,
    kelly_fraction: float,
    max_fraction: float,
    min_sample_to_persist: int,
) -> int:
    log(
        "MODEL PIPELINE START "
        f"sport={sport} model={model_name} league={league_slug} lookback={lookback_games} dry_run={dry_run}"
    )

    if sport == "mlb":
        rows = generate_autofilled_stats(
            output_path=output_path,
            lookback_games=lookback_games,
            include_live=include_live,
            league_slug=league_slug,
        )
        log(f"FETCH OK rows={rows} output={output_path}")
        if rows <= 0:
            log("PIPELINE ABORT: no hay fixtures activos con datos suficientes.")
            return 2
        processed, skipped = ingest_csv(output_path, model_name, dry_run)
    elif sport == "nba":
        rows = fetch_nba_features(model_name, lookback_games, include_live, dry_run)
        log(f"FETCH OK rows={rows} target=model_features")
        if rows <= 0:
            log("PIPELINE ABORT: no hay fixtures NBA activos con datos suficientes.")
            return 2
        processed, skipped = ingest_features(sport, model_name, dry_run)
    elif sport == "football":
        rows = fetch_football_features(model_name, league_slug, lookback_games, include_live, dry_run)
        log(f"FETCH OK rows={rows} target=model_features")
        if rows <= 0:
            log("PIPELINE ABORT: no hay fixtures football activos con datos suficientes.")
            return 2
        processed, skipped = ingest_features(sport, model_name, dry_run, league_slug=league_slug)
    else:
        log(f"PIPELINE ABORT: sport no soportado: {sport}")
        return 4

    log(f"INGEST OK processed={processed} skipped={skipped}")
    if processed <= 0:
        log("PIPELINE ABORT: ingesta sin predicciones procesadas.")
        return 3

    if skip_optimizer:
        log("OPTIMIZER SKIPPED")
        return 0

    summary = analyze(model_name, sport_slug=optimizer_sport_slug(sport))
    if compact_logs:
        log(
            "OPTIMIZER SUMMARY "
            f"sample={summary.sample_size} accuracy={summary.accuracy:.2%} "
            f"brier={summary.brier_score:.4f} bias_home={summary.bias_home:+.4f}"
        )
    else:
        print_summary(summary, dry_run=dry_run)
    if not dry_run and summary.sample_size >= min_sample_to_persist:
        persist_summary(summary, suggestion_for(summary))
        log("OPTIMIZER OK: model_parameters actualizado.")
    elif not dry_run:
        log(
            "OPTIMIZER SKIPPED PERSIST "
            f"sample={summary.sample_size} min_sample_to_persist={min_sample_to_persist}"
        )
    else:
        log("OPTIMIZER OK: dry_run sin persistencia.")

    if skip_alpha:
        log("ALPHA SKIPPED")
    else:
        evaluated, opportunities = detect_alpha(
            model_name=model_name,
            min_ev=min_ev,
            max_model_age_minutes=240,
            max_market_age_minutes=30,
            dry_run=dry_run,
            auto_paper=auto_paper,
            stake_mode=stake_mode,
            flat_fraction=flat_fraction,
            kelly_fraction=kelly_fraction,
            max_fraction=max_fraction,
        )
        log(f"ALPHA OK evaluated={evaluated} opportunities={opportunities}")

    log(
        "MODEL PIPELINE OK "
        f"sport={sport} model={model_name} fetched={rows} processed={processed} "
        f"skipped={skipped} optimizer_sample={summary.sample_size}"
    )
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Ejecuta fetcher -> ingest_stats -> optimizer.")
    parser.add_argument("--sport", choices=["football", "mlb", "nba"], default="mlb")
    parser.add_argument("--model-name", default="carlos_v1_mlb")
    parser.add_argument("--output", default="/tmp/stats_input_auto.csv")
    parser.add_argument("--lookback-games", type=int, default=10)
    parser.add_argument("--league-slug", default="mlb")
    parser.add_argument("--include-live", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-optimizer", action="store_true")
    parser.add_argument("--skip-alpha", action="store_true")
    parser.add_argument("--min-ev", type=float, default=0.05)
    parser.add_argument("--compact-logs", action="store_true")
    parser.add_argument("--auto-paper", action="store_true", help="Crea paper_trades cuando alpha detecte EV+.")
    parser.add_argument("--stake-mode", choices=["flat", "kelly"], default="flat")
    parser.add_argument("--flat-fraction", type=float, default=0.01)
    parser.add_argument("--kelly-fraction", type=float, default=0.25)
    parser.add_argument("--max-fraction", type=float, default=0.02)
    parser.add_argument("--min-sample-to-persist", type=int, default=50)
    args = parser.parse_args()
    raise SystemExit(
        run_pipeline(
            sport=args.sport,
            model_name=args.model_name,
            output_path=args.output,
            lookback_games=args.lookback_games,
            league_slug=args.league_slug,
            include_live=args.include_live,
            dry_run=args.dry_run,
            skip_optimizer=args.skip_optimizer,
            skip_alpha=args.skip_alpha,
            min_ev=args.min_ev,
            compact_logs=args.compact_logs,
            auto_paper=args.auto_paper,
            stake_mode=args.stake_mode,
            flat_fraction=args.flat_fraction,
            kelly_fraction=args.kelly_fraction,
            max_fraction=args.max_fraction,
            min_sample_to_persist=args.min_sample_to_persist,
        )
    )


if __name__ == "__main__":
    main()
