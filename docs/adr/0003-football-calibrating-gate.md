# ADR 0003: Football Calibrating Gate

## Status

Accepted.

## Decision

Football model quotes with positive EV can reach CALIBRATING or shadow review workflows, but they cannot become FOOTBALL_CONFIRMED_PAPER while the model is UNCALIBRATED_PRIOR or CALIBRATING.

## Context

Football has many contextual variables and strong model-market gap risk. A good fair odds read is not enough without real market quotes, verified lineups, goalkeeper status, closing odds, settlement, CLV, Brier, log loss, and segment behavior.

## Consequences

- Positive EV in football is a learning signal, not a confirmed pick.
- Segments need valid closing and settlement before decisions like PROMOTE_WATCH.
- Missing lineup or goalkeeper should degrade readiness.
- CALIBRATING must be visually distinct from confirmed paper in the dashboard.
