# Step 3 — Intent classification harness

Tests, in isolation, how accurately Claude classifies each mailbox email as
**order / not_order / unsure** — the triage that decides what enters the review
queue (only `order` and `unsure` proceed; `not_order` routes to the existing
ack/reply flow). Scored against the answer keys' classification labels
(ground-truth `ambiguous` == model `unsure`).

## Run it (cost-aware order)

```bash
# See what's testable — no API call
node src/step3-classification/run.js --list

# Estimate cost — token counting only (free)
node src/step3-classification/run.js --estimate --all

# Classify ONE sample
node src/step3-classification/run.js --sample S05

# Classify all 50
node src/step3-classification/run.js --all

# Re-score the last report offline after tweaking scoring (free)
node src/step3-classification/run.js --rescore
```

On this corporate network, prefix Node with `NODE_OPTIONS=--use-system-ca` (trusts
the Windows cert store) so the API call gets through TLS inspection — same as Step 2.

## What it reports

- **Overall accuracy** and **per-class recall** (order / not_order / unsure).
- A **confusion matrix** (rows = truth, cols = prediction).
- **Missed orders** — real orders labeled `not_order`. This is the costly error
  (a dropped order), called out separately.
- `samples/step3-report.json` captures each sample's predicted label, confidence,
  and one-sentence reasoning — useful both for debugging and for deciding the
  brief's open question (show reviewers the raw confidence/reasoning, or a simple flag).

## Notes

- All 50 samples are testable (each has a ground-truth classification).
- Model is env-switchable (`MODEL=claude-sonnet-5`), like Step 2.
- The classifier reads the same input as extraction (email body + any attachment
  text). For the 3 pending-binary samples (S12/S13/S35) it sees the forwarding
  email but not the unreadable PDF — a realistic "thin signal" case.
