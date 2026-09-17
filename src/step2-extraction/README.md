# Step 2 — Extraction harness

Tests, in isolation, how accurately Claude pulls structured order data out of the
Step-1 sample emails. No Business Central, no UI, no queue. It reads each sample,
sends it to Claude, and scores the result field-by-field against the drafted
answer keys.

## Setup

```bash
npm install
```

The API key is read from `.env` (`ANTHROPIC_API_KEY=...`) — already in place, git-ignored.

## Run it (cost-aware order)

```bash
# 1) See what's testable — no API call, spends nothing
node src/step2-extraction/run.js --list

# 2) Estimate cost — counts input tokens only (token counting is free), confirms the key works
node src/step2-extraction/run.js --estimate --all

# 3) Run ONE sample (safe default) — a real extraction + score
node src/step2-extraction/run.js --sample S03

# 4) Run everything once you're happy
node src/step2-extraction/run.js --all
```

Guardrail: with **no target flag** it just prints help and the testable list — it never spends by accident.

## Options

| Flag | Meaning |
|---|---|
| `--list` | list extraction-testable samples, spend nothing |
| `--estimate` | count input tokens / estimate cost only (no generation) |
| `--rescore` | re-score the last saved report offline (no API calls) — iterate on scoring/answer keys for free |
| `--sample S07` | run one sample |
| `--all` / `--limit N` | run all / first N |
| `--model <id>` | default `claude-opus-5`; e.g. `--model claude-sonnet-5` to cut cost |
| `--effort <level>` | default `medium` (`low`\|`medium`\|`high`\|`xhigh`\|`max`) |
| `--out <file>` | report path (default `samples/step2-report.json`) |

Model can also be set via env: `MODEL=claude-sonnet-5 node src/step2-extraction/run.js --all`.

## What "testable" means

Only samples whose answer key has a real `extraction` object (the **order** samples
with captured content) are run — 12 of the 23. The `not_order` / `ambiguous`
samples have no expected extraction (they're for Step 3, classification), and
`S12`/`S13` are excluded until their native binaries are exported (their text
couldn't be read).

## Output

Per sample: an overall %, plus which pillars passed — PO number, customer, line
count, and per-line accuracy (part / quantity / unit price). A full
`samples/step2-report.json` captures every extracted value and every check so you
can see *exactly* what differed and improve the prompt in `extract.js`.

## Model choice & cost

Default is `claude-opus-5`. Extraction is a good candidate for a cheaper model —
try `--model claude-sonnet-5` (or `claude-haiku-4-5`) and compare the score to the
Opus run. That trade-off (accuracy vs. cost) is your call; the harness makes it a
one-flag experiment.

## Caveat

Answer keys are `verified:false` — drafted, not human-confirmed. Treat any accuracy
number as provisional until they're checked. And until native binaries replace the
connector's extracted text, this measures text-extraction fidelity, not the
native-PDF path (see `samples/FINDINGS.md`).
