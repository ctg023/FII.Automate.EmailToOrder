# CLAUDE.md — project guide for Claude Code sessions

Keep this current. It's the fast-start context for anyone (human or Claude) picking up this project.
Detailed live status is in [PROJECT-STATUS.md](PROJECT-STATUS.md).

## What this is
An internal tool that reads incoming **order emails** from a shared `orders@` mailbox, extracts the
order, checks it against **Business Central**, and lets a sales rep **approve** each one before it's
created in BC. Goal: cut manual order entry for ~10 reps while keeping a human in the loop.

**A human approves every order before it is created in BC. No auto-create — ever, at least through rollout.**

## Status (2026-09-17)
- **Step 1 (sample set):** done — 50 labeled sample emails in `samples/` (29 order, 8 ambiguous, 13 not_order).
- **Step 2 (extraction):** done — harness in `src/step2-extraction/`; ~100% on order content.
- **Step 3 (classification):** done — harness in `src/step3-classification/`; 92%, **0 dropped orders**.
- **Step 4 (BC verification):** connectivity **proven** (read-only) via `src/step4-bc-verification/ping.js`.
  Next: answer the two data-quality questions (item cross-reference population, salesperson-code coverage),
  catalog the verification rules, then build the read-only checks.
- Later: review-queue web app (Teams tab), order creation vs a BC sandbox, pilot with 1–2 reps.

## Stack & architecture
- **Node.js (ESM)** throughout. No build step; run `.js` directly with `node`.
- **Decoupled stages** (ingest → classify → extract → verify → review → create) so the BC layer can be
  swapped at the future SaaS migration without rebuilding the rest.
- **Hosting:** on-prem, domain-joined Windows VM next to the BC server. Outbound HTTPS only (Graph, Claude);
  no inbound BC exposure. Off-network reps reach the review app via existing GlobalProtect.
  *Recommended (not yet confirmed):* IIS reverse proxy → a standalone Node Windows service (NOT `iisnode`).

## Repo layout
```
src/step2-extraction/     # extraction harness (schema.js, extract.js, score.js, run.js)
src/step3-classification/ # order/not_order/unsure classifier (same shape)
src/step4-bc-verification/# ping.js = read-only BC connectivity/permissions probe
samples/                  # test set. README + extraction-schema.json are committed;
                          #   raw/, answer-keys/, manifest.csv, FINDINGS.md are git-ignored (customer data)
.env                      # secrets (git-ignored). Copy from .env.example
PROJECT-STATUS.md         # living status + open items
```

## Running the harnesses
On this network, prefix Node with `NODE_OPTIONS=--use-system-ca` (see gotchas).
```bash
npm install
node src/step2-extraction/run.js --list          # what's testable (free)
node src/step2-extraction/run.js --estimate --all # token/cost estimate only (free)
node src/step2-extraction/run.js --sample S03     # run ONE (safe default)
node src/step2-extraction/run.js --all            # run all, then --rescore is free
node src/step3-classification/run.js --all        # classifier
node src/step4-bc-verification/ping.js            # BC read-only smoke test (needs BC_* in .env)
```
Guardrail: harnesses run nothing without an explicit `--sample`/`--all`/`--estimate` flag.

## Conventions
- **Claude API:** `@anthropic-ai/sdk`, `client.messages.parse()` with **Zod v4** structured output
  (`import { z } from "zod/v4"` — the SDK's `zodOutputFormat` needs v4).
- **Default model `claude-opus-5`**, overridable per run: `MODEL=claude-sonnet-5 node ...` (extraction/
  classification are good cheaper-model candidates — the user's call, not an automatic downgrade).
- **API key must be workspace-scoped** (Anthropic Console "Buckeye Auto Order" workspace). If an org key is
  used instead, set `ANTHROPIC_WORKSPACE_ID`. Key lives in `.env`.
- Cost discipline: estimate first (`--estimate`), run one sample before `--all`, print $ after each run.

## Environment gotchas (must persist on the VM too)
- **Corporate TLS inspection** breaks npm, Claude API, and BC calls with `SELF_SIGNED_CERT_IN_CHAIN`.
  Fix: run Node with **`NODE_OPTIONS=--use-system-ca`** (trusts the Windows/corporate CA), or set it as a
  machine env var. `npm config`/git also need the corporate CA (git: `http.sslBackend schannel`).
- **Secrets in `.env` only** (git-ignored). Never commit keys/passwords.

## Key decisions & corrections
- **BC auth = `NavUserPassword`** (dedicated BC service user + password over HTTPS) for **on-prem now**.
  ⚠️ Web Service Access Keys / basic-auth access keys are **deprecated — do not use** (an earlier plan
  said WSAK; that was wrong). When the company moves to BC **SaaS (~Feb 2027)** this one auth layer swaps
  to **OAuth 2.0 Service-to-Service** (Entra app registration). Don't build OAuth now.
- BC API: standard **OData v4 / API v2.0** endpoints, read-only for verification; order creation later, sandbox first.
- **Mailbox** is an Exchange Online shared mailbox; read via **Microsoft Graph** (`Mail.Read.Shared`).

## Data & integration notes
- The M365 Graph connector returns attachment **extracted text, not native files**; **scanned or
  `octet-stream`-mislabeled PDFs return no text** and need a native-file export (samples S12/S13/S35).
- **No CSV/Excel email orders** were found — structured customers arrive via **EDI straight into BC**.
  Email order formats in practice: PDF (most), body text, occasional Word.
- Real customer sample data is **kept out of the (public) repo** and is **regenerable** from the mailbox.

## Working preferences (from the user)
- **Stick to the agreed plan. Do not introduce architecture/tooling/hosting choices on the fly** — surface
  options as questions and let the user decide (e.g. IIS was suggested unprompted and pushed back on).
- Be honest about what's a settled decision vs. an open item; verify facts (esp. BC/Microsoft specifics)
  rather than asserting from memory.

## Where secrets & PII live (never in git)
`.env` (Anthropic key, BC credentials) · `samples/raw` + `answer-keys` + `manifest.csv` + `FINDINGS.md`
(customer names, contacts, PO numbers, pricing) · the user's Claude Code memory dir.
