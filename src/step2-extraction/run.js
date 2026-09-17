// Step 2 extraction harness — CLI.
//
//   node src/step2-extraction/run.js --list                 # what's testable, spends nothing
//   node src/step2-extraction/run.js --estimate --all       # token/cost estimate only (cheap)
//   node src/step2-extraction/run.js --sample S03            # run ONE sample (default-safe)
//   node src/step2-extraction/run.js --all                  # run every extraction-testable sample
//   node src/step2-extraction/run.js --limit 3              # run the first N
//   MODEL=claude-sonnet-5 node ... --all                    # switch model to cut cost
//
// Guardrail: with no target flag it prints help and spends nothing.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import {
  SAMPLES_DIR, DEFAULT_MODEL, DEFAULT_EFFORT,
  makeClient, loadSample, loadAnswerKey, extractOne, countOne,
} from "./extract.js";
import { scoreSample, aggregate } from "./score.js";

// $ per 1M tokens (from the claude-api skill's model table). in/out.
const PRICING = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  "claude-fable-5-1": { in: 10, out: 50 },
};

function parseArgs(argv) {
  const a = { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--all") a.all = true;
    else if (t === "--estimate") a.estimate = true;
    else if (t === "--rescore") a.rescore = true;
    else if (t === "--list") a.list = true;
    else if (t === "--sample") a.sample = argv[++i];
    else if (t === "--limit") a.limit = Number(argv[++i]);
    else if (t === "--model") a.model = argv[++i];
    else if (t === "--effort") a.effort = argv[++i];
    else if (t === "--out") a.out = argv[++i];
  }
  return a;
}

// Extraction-testable = has an answer key with a non-null `extraction` object.
function testableSamples() {
  const rawDir = path.join(SAMPLES_DIR, "raw");
  const ids = fs.readdirSync(rawDir).filter((d) => /^S\d+$/.test(d)).sort();
  const out = [];
  for (const id of ids) {
    const key = loadAnswerKey(id);
    if (key && key.extraction && typeof key.extraction === "object") out.push(id);
  }
  return out;
}

function pickIds(args) {
  const all = testableSamples();
  if (args.sample) return [args.sample];
  if (args.all) return all;
  if (args.limit) return all.slice(0, args.limit);
  return null; // no target
}

const usage = `
Step 2 extraction harness — reads samples, calls Claude, scores vs answer keys.

  --list                 list extraction-testable samples (spends nothing)
  --estimate --all       estimate input tokens/cost only (cheap; no generation)
  --sample S03           run ONE sample
  --all | --limit N      run all / first N
  --model <id>           default ${DEFAULT_MODEL}  (e.g. claude-sonnet-5 to cut cost)
  --effort <level>       default ${DEFAULT_EFFORT} (low|medium|high|xhigh|max)
  --out <file>           report path (default samples/step2-report.json)
`;

async function main() {
  const args = parseArgs(process.argv);

  // Re-score the last report offline — no API calls, no cost. Lets us iterate on
  // scoring/answer keys without paying to re-extract.
  if (args.rescore) {
    const reportPath = args.out || path.join(SAMPLES_DIR, "step2-report.json");
    const prev = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const results = [];
    console.log(`Re-scoring ${prev.results.length} sample(s) from ${reportPath} (no API calls)...\n`);
    for (const r of prev.results) {
      if (!r.extracted) { results.push(r); continue; }
      const key = loadAnswerKey(r.id);
      const s = scoreSample(key.extraction, r.extracted);
      results.push({ id: r.id, score: s.score, checks: s.checks, detail: s, extracted: r.extracted });
      console.log(
        `  ${s.score === 1 ? "OK " : "   "}${r.id}: ${(s.score * 100).toFixed(0)}%  ` +
        `[po:${s.checks.po_number ? "Y" : "n"} cust:${s.checks.customer_name ? "Y" : "n"} ` +
        `lines:${s.actLineCount}/${s.expLineCount} lineAcc:${(s.lineAccuracy * 100).toFixed(0)}%]`,
      );
    }
    const agg = aggregate(results);
    console.log(`\n== Summary (re-scored, no new extraction) ==`);
    console.log(`Samples scored: ${agg.count}`);
    console.log(`Mean score: ${(agg.meanScore * 100).toFixed(1)}%`);
    console.log(`PO# correct: ${agg.poOk}/${agg.count} | Customer correct: ${agg.custOk}/${agg.count} | Line count correct: ${agg.lineCountOk}/${agg.count}`);
    fs.writeFileSync(reportPath, JSON.stringify({ ...prev, rescoredAt: new Date().toISOString(), summary: agg, results }, null, 2));
    console.log(`\nUpdated report written to ${reportPath}`);
    return;
  }

  if (args.list || (!args.sample && !args.all && !args.limit && !args.estimate)) {
    const ids = testableSamples();
    console.log(usage);
    console.log(`Extraction-testable samples (${ids.length}): ${ids.join(", ")}`);
    if (!args.list) console.log("\nNo target given — nothing run, nothing spent. Add --sample / --all / --estimate.");
    return;
  }

  const ids = pickIds(args) || testableSamples();
  const price = PRICING[args.model];
  const client = makeClient();

  // ---- estimate mode: count tokens only ----
  if (args.estimate) {
    let totalIn = 0;
    console.log(`Estimating input tokens for ${ids.length} sample(s) on ${args.model}...\n`);
    for (const id of ids) {
      const n = await countOne(client, loadSample(id), args);
      totalIn += n;
      console.log(`  ${id}: ${n} input tokens`);
    }
    console.log(`\nTotal input tokens: ${totalIn}`);
    if (price) {
      const inCost = (totalIn / 1e6) * price.in;
      console.log(`Approx input cost: $${inCost.toFixed(4)} (output not included; typically small for extraction)`);
    }
    console.log("Note: real runs add output tokens + any thinking tokens; this is a floor.");
    return;
  }

  // ---- real run: extract + score ----
  const results = [];
  let usIn = 0, usOut = 0;
  console.log(`Running extraction on ${ids.length} sample(s) with ${args.model} (effort=${args.effort})...\n`);
  for (const id of ids) {
    const sample = loadSample(id);
    const key = loadAnswerKey(id);
    try {
      const { parsed_output, usage: u, stop_reason } = await extractOne(client, sample, args);
      usIn += u.input_tokens || 0;
      usOut += u.output_tokens || 0;
      if (stop_reason === "refusal") {
        console.log(`  ${id}: REFUSAL (skipped scoring)`);
        results.push({ id, error: "refusal" });
        continue;
      }
      const s = scoreSample(key.extraction, parsed_output);
      results.push({ id, score: s.score, checks: s.checks, detail: s, extracted: parsed_output });
      const flag = s.score === 1 ? "OK " : "   ";
      console.log(
        `  ${flag}${id}: ${(s.score * 100).toFixed(0)}%  ` +
        `[po:${s.checks.po_number ? "Y" : "n"} cust:${s.checks.customer_name ? "Y" : "n"} ` +
        `lines:${s.actLineCount}/${s.expLineCount} lineAcc:${(s.lineAccuracy * 100).toFixed(0)}%]`,
      );
    } catch (err) {
      console.log(`  ${id}: ERROR ${err?.message || err}`);
      results.push({ id, error: String(err?.message || err) });
    }
  }

  const agg = aggregate(results);
  console.log(`\n== Summary ==`);
  console.log(`Samples scored: ${agg.count}`);
  console.log(`Mean score: ${(agg.meanScore * 100).toFixed(1)}%`);
  console.log(`PO# correct: ${agg.poOk}/${agg.count} | Customer correct: ${agg.custOk}/${agg.count} | Line count correct: ${agg.lineCountOk}/${agg.count}`);
  console.log(`Tokens: ${usIn} in / ${usOut} out`);
  if (price) {
    const cost = (usIn / 1e6) * price.in + (usOut / 1e6) * price.out;
    console.log(`Approx cost this run: $${cost.toFixed(4)} on ${args.model}`);
  }

  const outPath = args.out || path.join(SAMPLES_DIR, "step2-report.json");
  fs.writeFileSync(outPath, JSON.stringify({
    model: args.model, effort: args.effort, ranAt: new Date().toISOString(),
    summary: agg, tokens: { in: usIn, out: usOut }, results,
  }, null, 2));
  console.log(`\nFull report written to ${outPath}`);
  console.log(`Reminder: answer keys are verified:false — treat this number as provisional until they're human-checked.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
