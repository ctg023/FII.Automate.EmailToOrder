// Merge purchase-order threads that Outlook split across conversations.
//
// One PO's paperwork often arrives under multiple Graph conversationIds — e.g. the
// customer's "Re:" reply thread and an internal "FW:" forward, sometimes from
// different senders. The pipeline groups strictly by conversationId, so the PO PDF
// and its spec-sheet/print end up on separate review cards and extract in pieces.
//
// This merges such threads BEFORE classify/extract, so a PO is one card carrying all
// its messages + attachments. Grouping runs before extraction, so we can't use the
// (not-yet-extracted) PO number — we derive merge keys from the SUBJECT:
//   • BC/Q number  — a BC-generated quote number, globally unique -> strong key.
//   • PO token     — guarded (>=5 chars AND contains a digit) so two customers'
//                    short/round PO numbers don't collide (PO numbers are per-customer).
// Two threads merge if they share ANY key. Threads with no key pass through unchanged
// (same object, same conversationId) — so enabling this never reshuffles the rest of
// the queue or invalidates unrelated caches.
//
// The merged thread keeps the SAME shape as a normal thread (conversationId, subject,
// messages[], last_received, message_ids[], has_attachments) with a deterministic
// synthetic conversationId, so every downstream consumer works unchanged.

// --- key extraction (from subject text) ---------------------------------------
// BC/Q number, e.g. "(BC/Q # 228909)". >=4 digits.
export function bcqKeys(subject) {
  const out = new Set();
  const re = /\bBC\s*\/\s*Q\s*#?\s*(\d{4,})/gi;
  let m;
  while ((m = re.exec(subject || ""))) out.add(`bcq:${m[1]}`);
  return [...out];
}
// PO token, e.g. "PO 287921", "P.O.# ABC-1234". GUARDED: keep only strong tokens
// (>=5 alphanumerics AND at least one digit) to avoid cross-customer collisions.
export function poKeys(subject) {
  const out = new Set();
  const re = /\bP\.?\s*O\.?\s*(?:#|number|no\.?|num)?[:\s#-]*([A-Za-z0-9][A-Za-z0-9/-]{3,})/gi;
  let m;
  while ((m = re.exec(subject || ""))) {
    const tok = m[1].replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (tok.length >= 5 && /\d/.test(tok)) out.add(`po:${tok}`);
  }
  return [...out];
}
// The bare BC/Q number(s) in a subject/body, e.g. "228874" — for the price check.
export const bcqNumbers = (text) => bcqKeys(text).map((k) => k.slice(4));

// All merge keys for a thread (scan every message subject, not just the base one).
export function threadKeys(thread) {
  const keys = new Set();
  for (const m of thread.messages || []) {
    for (const k of bcqKeys(m.subject)) keys.add(k);
    for (const k of poKeys(m.subject)) keys.add(k);
  }
  // also the thread-level subject (covers the base/representative subject)
  for (const k of bcqKeys(thread.subject)) keys.add(k);
  for (const k of poKeys(thread.subject)) keys.add(k);
  return [...keys];
}

// --- union-find over threads sharing keys -------------------------------------
function groupIndices(threads) {
  const parent = threads.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => { parent[find(a)] = find(b); };
  const keyToIdx = new Map();
  threads.forEach((t, i) => {
    for (const k of threadKeys(t)) {
      if (keyToIdx.has(k)) union(keyToIdx.get(k), i);
      else keyToIdx.set(k, i);
    }
  });
  const groups = new Map();
  threads.forEach((_, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  });
  return [...groups.values()];
}

// Strip Re:/Fw:/Fwd: prefixes for a clean representative subject.
const stripReply = (s) => String(s || "").replace(/^\s*(re|fw|fwd)\s*:\s*/i, "").trim();

// Deterministic synthetic id for a merged group: prefer the smallest BC/Q key, else
// the smallest PO key. Basing it on ONE strongest key keeps the id (and thus the
// cache entry) stable even if a later reply adds another key to the group.
function groupId(keys) {
  const bcq = keys.filter((k) => k.startsWith("bcq:")).sort();
  const po = keys.filter((k) => k.startsWith("po:")).sort();
  const primary = bcq[0] || po[0] || "x";
  return `grp:${primary}`;
}

// Build one merged thread object from a set of member threads.
function mergeGroup(members) {
  const messages = members
    .flatMap((t) => t.messages || [])
    .slice()
    .sort((a, b) => (a.received || "").localeCompare(b.received || ""));
  const keys = [...new Set(members.flatMap(threadKeys))];
  const inbound = messages.find((m) => m.direction === "inbound") || messages[0];
  const last = messages[messages.length - 1];
  return {
    conversationId: groupId(keys),
    subject: stripReply(inbound?.subject) || members.map((m) => m.subject).find(Boolean) || "(no subject)",
    messages,
    last_received: last?.received || null,
    has_attachments: messages.some((m) => (m.attachments || []).length),
    message_ids: messages.map((m) => m.message_id),
    merged: true,
    // Accumulate the ORIGINAL conversationIds (flatten already-merged members) so the
    // caller can prune every single-conversation card this super-thread supersedes.
    mergedFrom: [...new Set(members.flatMap((m) => (m.merged ? m.mergedFrom : [m.conversationId])))],
    mergeKeys: keys,
  };
}

// Public: force-merge an explicit list of thread objects into one (used by the
// cache-aware pass, which already decided they belong together on a shared key).
export function mergeThreadObjects(members) {
  return members.length === 1 ? members[0] : mergeGroup(members);
}

// Public: merge split PO threads. Singleton groups pass through UNCHANGED (same
// object, same conversationId). Returns threads newest-activity-first, like the input.
export function mergeThreads(threads) {
  const out = [];
  for (const idxs of groupIndices(threads)) {
    if (idxs.length === 1) out.push(threads[idxs[0]]);        // untouched
    else out.push(mergeGroup(idxs.map((i) => threads[i])));   // merged super-thread
  }
  out.sort((a, b) => (b.last_received || "").localeCompare(a.last_received || ""));
  return out;
}

// Public: describe proposed merges without changing anything (for --merge-preview).
export function previewMerges(threads) {
  return groupIndices(threads)
    .filter((idxs) => idxs.length > 1)
    .map((idxs) => {
      const members = idxs.map((i) => threads[i]);
      const keys = [...new Set(members.flatMap(threadKeys))];
      return {
        id: groupId(keys),
        keys,
        members: members.map((t) => ({
          conversationId: t.conversationId,
          subject: t.subject,
          from: (t.messages || []).map((m) => m.from).filter(Boolean)[0] || "",
          messages: (t.messages || []).length,
          attachments: (t.messages || []).reduce((n, m) => n + (m.attachments || []).length, 0),
        })),
      };
    });
}
