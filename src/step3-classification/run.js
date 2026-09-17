// Step 3 classification harness — CLI (mirrors the Step 2 runner).
//
//   node src/step3-classification/run.js --list            # what's testable, spends nothing
//   node src/step3-classification/run.js --estimate --all   # token/cost estimate only (cheap)
//   node src/step3-classification/run.js --sample S05        # classify ONE sample
//   node src/step3-classification/run.js --all               # classify all 50
//   node src/step3-classification/run.js --rescore           # re-score last report offline (free)
//   MODEL=claude-sonnet-5 node ... --all                     # switch model to cut cost
//
// Guardrail: with no target flag it prints help and spends nothing.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import {
  SAMPLES_DIR, DEFAULT_MODEL, DEFAULT_EFFORT,
  makeClient, loadSample, loadAnswerKey, buildUserContent,
} from "../step2-extraction/extract.js";
import { classifyOne, SYSTEM } from "./classify.js";
import { scoreOne, aggregate, printMatrix } from "./score.js";

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

// Classification-testable = any sample whose answer key has a classification.
function testableSamples() {
  const rawDir = path.join(SAMPLES_DIR, "raw");
  const ids = fs.readdirSync(rawDir).filter((d) => /^S\d+$/.test(d)).sort();
  return ids.filter((id) => { const k = loadAnswerKey(id); return k && k.classification; });
}

function pickIds(args) {
  const all = testableSamples();
  if (args.sample) return [args.sample];
  if (args.all) return all;
  if (args.limit) return all.slice(0, args.limit);
  return null;
}

const usage = `
Step 3 classification harness — order / not_order / unsure, scored vs the labels.

  --list                 list testable samples (spends nothing)
  --estimate --all       estimate input tokens/cost only (cheap; no generation)
  --sample S05           classify ONE sample
  --all | --limit N      classify all / first N
  --rescore              re-score the last report offline (free)
  --model <id>           default ${DEFAULT_MODEL}  (e.g. claude-sonnet-5)
  --effort <level>       default ${DEFAULT_EFFORT}
  --out <file>           report path (default samples/step3-report.json)
`;

const reportPathFor = (args) => args.out || path.join(SAMPLES_DIR, "step3-report.json");

function printSummary(agg, tag = "") {
  console.log(`\n== Summary ${tag}==`);
  console.log(`Samples: ${agg.count}   Accuracy: ${(agg.accuracy * 100).toFixed(1)}% (${agg.correct}/${agg.count})`);
  for (const l of agg.labels) {
    const pc = agg.perClass[l];
    console.log(`  ${l.padEnd(9)} recall ${pc.recall == null ? "n/a" : (pc.recall * 100).toFixed(0) + "%"} (${pc.correct}/${pc.total})`);
  }
  console.log(`  ** missed orders (order -> not_order): ${agg.missedOrders} **  <- the costly error`);
  console.log("\nConfusion matrix (rows = truth, cols = prediction):");
  console.log(printMatrix(agg.matrix, agg.labels));
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.rescore) {
    const p = reportPathFor(args);
    const prev = JSON.parse(fs.readFileSync(p, "utf8"));
    const results = prev.results.map((r) => {
      if (!r.predicted) return r;
      const s = scoreOne(loadAnswerKey(r.id), r.predicted);
      return { ...r, ...s };
    });
    const agg = aggregate(results);
    for (const r of results) if (r.predicted) console.log(`  ${r.correct ? "OK " : "XX "}${r.id}: truth=${r.truth} pred=${r.predicted} conf=${r.confidence ?? "?"}`);
    printSummary(agg, "(re-scored) ");
    fs.writeFileSync(p, JSON.stringify({ ...prev, rescoredAt: new Date().toISOString(), summary: agg, results }, null, 2));
    console.log(`\nUpdated report written to ${p}`);
    return;
  }

  if (args.list || (!args.sample && !args.all && !args.limit && !args.estimate)) {
    const ids = testableSamples();
    console.log(usage);
    console.log(`Testable samples (${ids.length}): ${ids.join(", ")}`);
    if (!args.list) console.log("\nNo target given — nothing run, nothing spent. Add --sample / --all / --estimate.");
    return;
  }

  const ids = pickIds(args) || testableSamples();
  const price = PRICING[args.model];
  const client = makeClient();

  if (args.estimate) {
    let totalIn = 0;
    console.log(`Estimating input tokens for ${ids.length} sample(s) on ${args.model}...\n`);
    for (const id of ids) {
      const res = await client.messages.countTokens({ model: args.model, system: SYSTEM, messages: [{ role: "user", content: buildUserContent(loadSample(id)) }] });
      totalIn += res.input_tokens;
    }
    console.log(`Total input tokens: ${totalIn}`);
    if (price) console.log(`Approx input cost: $${((totalIn / 1e6) * price.in).toFixed(4)} (output is tiny for classification)`);
    return;
  }

  const results = [];
  let usIn = 0, usOut = 0;
  console.log(`Classifying ${ids.length} sample(s) with ${args.model} (effort=${args.effort})...\n`);
  for (const id of ids) {
    try {
      const { parsed_output: out, usage: u, stop_reason } = await classifyOne(client, loadSample(id), args);
      usIn += u.input_tokens || 0; usOut += u.output_tokens || 0;
      if (stop_reason === "refusal") { console.log(`  ${id}: REFUSAL`); results.push({ id, error: "refusal" }); continue; }
      const s = scoreOne(loadAnswerKey(id), out.classification);
      results.push({ id, predicted: out.classification, confidence: out.confidence, reasoning: out.reasoning, ...s });
      console.log(`  ${s.correct ? "OK " : "XX "}${id}: truth=${s.truth} pred=${s.predicted} conf=${(out.confidence ?? 0).toFixed(2)}`);
    } catch (err) {
      console.log(`  ${id}: ERROR ${err?.message || err}`);
      results.push({ id, error: String(err?.message || err) });
    }
  }

  const agg = aggregate(results);
  printSummary(agg);
  console.log(`\nTokens: ${usIn} in / ${usOut} out`);
  if (price) console.log(`Approx cost this run: $${((usIn / 1e6) * price.in + (usOut / 1e6) * price.out).toFixed(4)} on ${args.model}`);

  const p = reportPathFor(args);
  fs.writeFileSync(p, JSON.stringify({ model: args.model, effort: args.effort, ranAt: new Date().toISOString(), summary: agg, tokens: { in: usIn, out: usOut }, results }, null, 2));
  console.log(`\nFull report (incl. per-sample reasoning) written to ${p}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
