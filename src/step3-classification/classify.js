// Core classifier: read one sample, ask Claude whether it's a new order, a
// not-an-order, or genuinely unsure. Reuses the Step-2 sample loader so the
// input (email body + any attachment text) is built identically.
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  buildMessageContent, DEFAULT_MODEL, DEFAULT_EFFORT,
} from "../step2-extraction/extract.js";
import { Classification } from "./schema.js";

export const SYSTEM = `You triage emails sent to a fastener manufacturer's shared orders@ mailbox. Decide whether each email is a NEW customer purchase order that should be entered into Business Central.

Choose exactly one:
- "order": a clear new purchase order to create — a customer PO document, or an unambiguous body-text order with part(s) and quantity.
- "not_order": NOT a new order — e.g. order acknowledgments / thank-yous, shipment or status questions, "did you get my PO?" confirmation chasers, price or spec disputes, "keep on hold" / cancel instructions, EDI or supplier-portal notifications, internal system reports, or vendor spam/solicitations.
- "unsure": genuinely ambiguous — a human couldn't confidently decide without more context. Examples: a reply attaching a "revised/updated PO", an RFQ or price-and-lead-time request phrased like an order, an order placed only against a quote with an informal PO number, or a pending-order negotiation.

Decide on INTENT, not the mere presence of words like "PO", "order", or a PO number — many non-orders contain all of those. When the signals genuinely conflict, prefer "unsure" over guessing.

Return the label, a calibrated confidence in [0,1] that your label is correct, and a one-sentence reason.`;

export async function classifyOne(client, sample, opts = {}) {
  const model = opts.model || DEFAULT_MODEL;
  const effort = opts.effort || DEFAULT_EFFORT;
  const res = await client.messages.parse({
    model,
    max_tokens: 1024,
    system: SYSTEM,
    output_config: { format: zodOutputFormat(Classification), effort },
    messages: [{ role: "user", content: buildMessageContent(sample) }],
  });
  return { parsed_output: res.parsed_output, usage: res.usage, model, stop_reason: res.stop_reason };
}
