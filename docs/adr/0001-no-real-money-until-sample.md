# ADR 0001: No Real Money Until Clean Sample

## Status

Accepted.

## Decision

The system must keep REAL_CANDIDATE at 0 and keep real money, Kelly staking, Telegram auto-send, and autobet disabled until explicit human authorization after a statistically useful clean sample.

## Context

The dashboard can show paper performance, shadow tickets, EV, and theoretical profit. Those numbers can be misleading when the sample is small, when CLV is missing, or when closing quality is invalid.

## Consequences

- Paper and shadow can continue for learning.
- Football remains CALIBRATING until Brier/log loss/CLV and segment evidence improve.
- MLB remains moneyline-only for any serious paper promotion.
- No automation may convert manual, simulated, or shadow data into real wagers.
