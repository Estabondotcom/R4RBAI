// functions/index.js
// deleteCampaign is callable (onCall); aiTurn is HTTP (onRequest) with CORS.

import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2/options";
import admin from "firebase-admin";
import corsLib from "cors";
import OpenAI from "openai";

// ─────────────────────────── Firebase Admin init ───────────────────────────
if (!admin.apps.length) admin.initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

// ───────────────────────────── deleteCampaign ──────────────────────────────
export const deleteCampaign = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

  const campaignId = request.data?.campaignId;
  if (!campaignId || typeof campaignId !== "string") {
    throw new HttpsError("invalid-argument", "campaignId is required.");
  }

  const ref = admin.firestore().collection("campaigns").doc(campaignId);
  const snap = await ref.get();
  if (!snap.exists) {
    // idempotent delete
    return { ok: true, message: "Not found (already deleted)" };
  }

  const data = snap.data();
  if (data?.uid && data.uid !== uid) {
    throw new HttpsError("permission-denied", "Not your campaign.");
  }

  await admin.firestore().recursiveDelete(ref);
  return { ok: true };
});

// ──────────────────────────────── aiTurn ───────────────────────────────────
const ALLOWED_ORIGIN = "https://estabondotcom.github.io";
const cors = corsLib({ origin: ALLOWED_ORIGIN });

// small helpers to inject contextual nudges safely
function lootHintSnippet(want) {
  return want
    ? "HINT: The client signals that an inventory proposal may be appropriate this turn. If it fits the scene, include an inventory_proposal with 1 item; otherwise omit it."
    : "";
}
function allowedTraitsSnippet(list) {
  if (!Array.isArray(list) || list.length === 0) return "";
  return "Allowed trait names for items: " + list.join(", ") + ". Never invent new trait names.";
}
function suppressNarrativeSnippet(suppress) {
  return suppress ? "IMPORTANT: Respond ONLY with the first-line OOC JSON. Do NOT include NARRATIVE." : "";
}

export const aiTurn = onRequest({ secrets: ["OPENAI_API_KEY"] }, (req, res) => {
  cors(req, res, async () => {
    // Always reflect CORS on every path
    res.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.set("Vary", "Origin");
    res.set("Cache-Control", "no-store");

    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      return res.status(204).send("");
    }
    if (req.method !== "POST") {
      return res.status(405).send("POST only");
    }

    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const body = req.body || {};
      const wantLoot = !!(body?.hints?.want_inventory_proposal);
      const allowedTraits = Array.isArray(body?.allowed_traits) ? body.allowed_traits : [];
      const suppressNarrative = !!(body?.meta?.suppressNarrative);

      // ★ System prompt teaches inventory_proposal + third person + “Do Anything” fallback
      const system = `You are the AI GM for "Roll for Rocket Boots".
Reply in two parts unless instructed otherwise:
1) First line: {"ooc":{"need_roll":true|false,"skill":"<Skill>","dieTier":1..4,"difficulty":8..24,"note":"optional","prompt":"optional"}}
2) Then a blank line and "NARRATIVE:" with 2–4 short, evocative paragraphs describing what happens.

Rules:
- NARRATIVE MUST be written in THIRD PERSON. Refer to the player character by name or “they,” never “you.”
- Keep tense consistent and immersive; avoid imperative phrasing (no "you see," "you feel," etc.).
- Do NOT roll dice; the client handles mechanics.
- If mechanics.roll_result is provided, set need_roll=false and narrate the outcome.
- Maintain story continuity with state_summary and recent_turns.

Skill usage constraints:
- Do NOT make up new skills.
- Only call for rolls using skills the player currently has in state_summary.pc.skills.
- Do NOT call for rolls for traits, items, or narrative abilities alone.
- If no listed skill logically fits the situation, call for a roll using the skill "Do Anything" as a fallback.
- If even "Do Anything" would be redundant, resolve narratively instead of requesting a roll.

Inventory proposals (do NOT auto-add items):
- If offering items, include an "inventory_proposal" object in the FIRST LINE JSON.
- STRICT schema:
  "inventory_proposal": {
    "add": [{"name":"", "qty":1, "matches":["trait1","trait2"], "why":"short reason"}]
  }
- Max 3 items per proposal; each qty 1–3. Omit "inventory_proposal" if none are proposed.
- Names and "matches" must follow the allowed trait list provided by the client; never invent new trait names.

Proposal cadence:
- Consider proposing an item when the player searches containers, visits vendors, finishes a risky task with a success/crit, or receives aid from NPCs.
- If it’s not appropriate this turn, omit the proposal.`.trim();

      // Build messages with contextual nudges from the client
      const messages = [
        { role: "system", content: system },
        lootHintSnippet(wantLoot) ? { role: "system", content: lootHintSnippet(wantLoot) } : null,
        allowedTraitsSnippet(allowedTraits) ? { role: "system", content: allowedTraitsSnippet(allowedTraits) } : null,
        suppressNarrativeSnippet(suppressNarrative) ? { role: "system", content: suppressNarrativeSnippet(suppressNarrative) } : null,
        { role: "user", content: JSON.stringify(body) }
      ].filter(Boolean);

      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.8,
        max_tokens: 600,
        messages
      });

      const text =
        resp.choices?.[0]?.message?.content?.trim() ||
        `{"ooc":{"need_roll":false,"prompt":"What do you do?"}}\n\nNARRATIVE:\nThe scene waits.`;

      return res.status(200).send({ text });
    } catch (err) {
      console.error(err);
      // keep CORS on error responses too
      return res.status(500).send({ error: "aiTurn failed" });
    }
  });
});

