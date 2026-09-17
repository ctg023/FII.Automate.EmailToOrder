// Core extraction: read one sample, build the prompt, ask Claude for structured
// order data validated against the Zod schema. Text-only for now (the connector
// gave us extracted text, not native files). When native binaries arrive
// (option-2 export), add a `document` content block here for real PDFs — see
// buildUserContent's TODO.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { OrderExtraction } from "./schema.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SAMPLES_DIR = path.resolve(here, "..", "..", "samples");

export const DEFAULT_MODEL = process.env.MODEL || "claude-opus-5";
export const DEFAULT_EFFORT = process.env.EFFORT || "medium"; // low|medium|high|xhigh|max

const SYSTEM = `You extract a customer's PURCHASE ORDER from an email sent to a fastener manufacturer (Buckeye Fasteners). The order may be in the email body, or in an attached PDF/Word document whose extracted text is provided.

Return ONLY the structured order, following these rules:
- Copy identifiers (PO number, part numbers) VERBATIM, including leading zeros and punctuation.
- Distinguish customer_part (the buyer's own part number) from supplier_part (Buckeye's SKU / "our part no." / MFG PT). If the customer cites only one, fill that one and leave the other null.
- Normalize unit_price to price PER EACH. If the document prices per hundred ("Cost/C", "per C", "/100") divide by 100; per thousand ("per M", "/M") divide by 1000. Keep line_total as the document's extended amount.
- Dates: ISO 8601 (YYYY-MM-DD) when unambiguous; otherwise copy verbatim. requested_ship_date is the customer's requested ship/delivery/due date.
- Use null for anything not present. NEVER invent a value. If there are no order line items, return an empty line_items array.
- ship_to is the destination for the goods (may differ from the sender's address).`;

/** Load a sample's email.json plus any extracted attachment text. */
export function loadSample(id) {
  const dir = path.join(SAMPLES_DIR, "raw", id);
  const email = JSON.parse(fs.readFileSync(path.join(dir, "email.json"), "utf8"));
  const attachments = [];
  for (const att of email.attachments || []) {
    if (att.saved_as) {
      const p = path.join(dir, att.saved_as);
      if (fs.existsSync(p)) {
        attachments.push({ name: att.name, text: fs.readFileSync(p, "utf8") });
      }
    }
  }
  return { id, email, attachments };
}

/** Load the drafted answer key for a sample (or null). */
export function loadAnswerKey(id) {
  const p = path.join(SAMPLES_DIR, "answer-keys", `${id}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
}

/** Build the user prompt text from an email + its attachment text. */
export function buildUserContent(sample) {
  const { email, attachments } = sample;
  const parts = [];
  parts.push(`FROM: ${email.sender?.name || ""} <${email.sender?.address || ""}>`);
  if (email.original_sender) {
    parts.push(`ORIGINAL SENDER: ${email.original_sender.name || ""} <${email.original_sender.address || ""}>`);
  }
  parts.push(`SUBJECT: ${email.subject || ""}`);
  parts.push(`RECEIVED: ${email.received || ""}`);
  parts.push("");
  parts.push("EMAIL BODY:");
  parts.push(email.body_text || "(empty)");
  for (const att of attachments) {
    parts.push("");
    parts.push(`--- ATTACHMENT: ${att.name} ---`);
    parts.push(att.text);
  }
  // TODO(native files): when a real PDF exists for this sample, return content
  // blocks instead of a string: [{type:"document", source:{type:"base64",
  // media_type:"application/pdf", data:<b64>}}, {type:"text", text:<the header>}].
  return parts.join("\n");
}

/** Run extraction for one sample. Returns { parsed_output, usage, model }. */
export async function extractOne(client, sample, opts = {}) {
  const model = opts.model || DEFAULT_MODEL;
  const effort = opts.effort || DEFAULT_EFFORT;
  const res = await client.messages.parse({
    model,
    max_tokens: 8000,
    system: SYSTEM,
    output_config: {
      format: zodOutputFormat(OrderExtraction),
      effort, // extraction is not deep reasoning; medium keeps cost down
    },
    messages: [{ role: "user", content: buildUserContent(sample) }],
  });
  return { parsed_output: res.parsed_output, usage: res.usage, model, stop_reason: res.stop_reason };
}

/** Count input tokens for one sample without generating (cheap cost estimate). */
export async function countOne(client, sample, opts = {}) {
  const model = opts.model || DEFAULT_MODEL;
  const res = await client.messages.countTokens({
    model,
    system: SYSTEM,
    messages: [{ role: "user", content: buildUserContent(sample) }],
  });
  return res.input_tokens;
}

export function makeClient() {
  // Reads ANTHROPIC_API_KEY from env (loaded via dotenv in run.js).
  // If the key is an org-level key (not workspace-scoped), the org may require a
  // workspace id header — set ANTHROPIC_WORKSPACE_ID to supply it. A
  // workspace-scoped key needs neither.
  const wsid = process.env.ANTHROPIC_WORKSPACE_ID;
  return new Anthropic(wsid ? { defaultHeaders: { "anthropic-workspace-id": wsid } } : {});
}
