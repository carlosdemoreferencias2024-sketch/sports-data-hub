# Safety Suite

The safety suite is the lightweight quality gate for sports-data-hub. It is intentionally smaller than Cypress and does not install new dependencies.

## What It Checks

- TypeScript build compiles.
- Audit guardrails still block real betting.
- Closing window logic keeps CAPTURED_ON_TIME strict.
- Source Capture Assistant rejects unsafe market sources.
- Live service health and dashboard markers are visible.
- Sensitive API routes are either protected by auth or return safe guardrails.

## Commands

From the backend folder:

```powershell
npm run test:safety
```

From the project root, without npm:

```powershell
scripts\run_safety_suite.cmd
```

The suite tries to write the latest report to:

```text
backend\uploads\safety-suite\latest.json
```

If that folder is locked by Windows, Docker, or OneDrive, it falls back to:

```text
%TEMP%\sports-data-hub-safety-suite-latest.json
```

Individual checks:

```powershell
npm run build
npm run test
npm run test:closing-window
npm run test:source-capture-assistant
npm run check:live-safe-mode
```

## Interpretation

Pass means the operating guardrails are intact. It does not mean the model has a bet.

Fail means stop the trading workflow and inspect the failed check before capturing odds, closing, or settlement.

## Cypress Later

Cypress can be added later for visual dashboard tests. Keep this safety suite even after Cypress exists because it is faster and catches the core guardrails without opening a browser.
