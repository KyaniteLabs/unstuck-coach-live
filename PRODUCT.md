# Unstuck Coach live product

A whole-person executive-function accessibility coach: accept a messy stuck point, name the friction without blame, offer one humane next move and a tiny check-in, while holding the remaining pile out of working memory. It is reflective/access support, not therapy, diagnosis, medication or crisis care.

## What exists

- Public landing and chat shell, a Node HTTP live-demo server, deploy assets and tests.
- A file-based coach contract, examples and body/calendar/inbox/admin/capture/re-entry/shutdown playbooks. Users may load these into an AI project independently of the hosted demo.
- Prompt-context assembly from ten allowlisted public files, bounded history/input, provider adapters, rate/concurrency/body limits and optional usage analytics.
- Model-backed chat depends on explicit provider configuration. Default non-compatible mode is OpenAI Responses; localhost/home compatibility is a separate choice. This is not guaranteed offline/free inference.

It does not autonomously read/send messages, access accounts or schedule events. Example transcripts/scorecards are calibration assets, not evidence of clinical benefit or actual user outcomes. This repository is separate from Innerscape and the portable protocol repo.

## Proof and limits

Actual context-assembly test passed; server/provider syntax checked. Chromium rendered the static chat shell with API requests blocked. No live model/chat reply, microphone/account access, analytics key, deploy or publication was exercised; no coaching-quality or user-side live acceptance claimed. See [ARCHITECTURE.md](ARCHITECTURE.md), [README.md](README.md) and [coach rules](coach/rules.md).
