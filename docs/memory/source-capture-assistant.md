# Source Capture Assistant Memory

Source Capture Assistant exists to make manual verified data traceable. It is not a scraper and not a betting bot.

## Allowed Workflow

Source visible on screen -> screenshot/text evidence -> evidence_id and screenshot_sha256 -> draft JSON -> human confirmation -> manual_verified POST -> preflight/bridge review.

## Required Evidence Fields

- evidence_id
- created_at
- screenshot_sha256 when screenshot exists
- evidence_path
- source_url
- match_id
- sport
- capture_type
- captured_at
- verified_by

## Safe States

- DRAFT_READY
- EVIDENCE_CAPTURED
- WAITING_HUMAN_CONFIRMATION
- SAFE_TO_POST_MANUAL_VERIFIED
- POSTED_MANUAL_VERIFIED
- REJECTED_UNSAFE_SOURCE

## Closing Odds Rules

closing_odds is safe_to_post_now only when:

- window_status is CAPTURE_CLOSING_NOW.
- source is sportsbook_manual_verified, bookmaker_manual_verified, or sportsdataio_manual_verified.
- captured_at is inside the valid 10-to-3 minute window.
- verified_by is present.
- source_url or manual_verified_screen evidence is present.

If window_status is WAITING_WINDOW, MISSED_WINDOW, or POST_KICKOFF_AUDIT_ONLY, the capture can remain as audit evidence but must not feed formal CLV.

## Explicitly Forbidden

- Autopost.
- Autobet.
- Login automation.
- Proxy rotation.
- Captcha solving.
- Cloudflare or anti-bot bypass.
- Mass scraping.
- Remote daemon exposure.
