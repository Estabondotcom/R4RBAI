// functions/index.js
// deleteCampaign is now callable (onCall) → no CORS needed.
// aiTurn remains HTTP (onRequest) with CORS for your GitHub Pages site.

import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2/options";
import admin from "firebase-admin";
import corsLib from "cors";
import OpenAI from "openai";

// ─────────────────────────── Firebase Admin init ───────────────────────────
if (!admin.apps.length) {
  admin.initializeApp();
}
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
    // Idempotent delete: treat missing doc as success
    return { ok: true, message: "Not found (already deleted)" };
  }

  const data = snap.data();
  if (data.uid !== uid) {
    throw new HttpsError("permission-denied", "Not your campaign.");
  }

  await admin.firestore().recursiveDelete(ref);
  return { ok: true };
});

// ──────────────────────────────── aiTurn ───────────────────────────────────
const ALLOWED_ORIGIN = "https://estabondotcom.github.io";
const cors = corsLib({ origin: ALLOWED_ORIGIN });

export const aiTurn = onRequest({ secrets: ["OPENAI_API_KEY"] }, (req, res) => {
  cors(req, res, async () => {
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
      res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
      return res.status(204).send("");
    }
    if (req.method !== "POST") return res.status(405).send("POST only");

    try {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const body = req.body || {};
      const system = `You are the AI GM for "Roll for Rocket Boots".
Reply in two parts:
1) First line: {"ooc":{"need_roll":true|false,"skill":"<Skill>","dieTier":1..4,"difficulty":8..24,"note":"optional","prompt":"optional"}}
2) Then a blank line and "NARRATIVE:" with 2–4 short, evocative paragraphs describing what happens.

Rules:
- NARRATIVE MUST be written in THIRD PERSON. Refer to the player character by name or “they,” never “you.”
- Keep tense consistent and immersive, avoiding imperative phrasing (no "you see," "you feel," etc.).
- Do NOT roll dice; the client handles mechanics.
- If mechanics.roll_result is provided, set need_roll=false and narrate the outcome.
- Maintain story continuity with state_summary and recent_turns.

Skill usage constraints:
- Do NOT make up new skills.
- Only call for rolls using skills the player currently has in state_summary.pc.skills.
- Do NOT call for rolls for traits, items, or narrative abilities alone.
- If no listed skill logically fits the situation, call for a roll using the skill **"Do Anything"**.
- Use "Do Anything" only as a fallback when no existing skill reasonably applies.
- If even "Do Anything" would be redundant, resolve narratively instead of requesting a roll.

Behavior:
- Stay within the tone of a lighthearted, narrative-driven tabletop RPG.
- Prefer describing the consequences of actions and world reactions.
- If uncertain, ask clarifying questions rather than assuming new skills or powers.`;

      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.8,
        max_tokens: 600,
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(body) },
        ],
      });

      const text =
        resp.choices?.[0]?.message?.content?.trim() ||
        `{"ooc":{"need_roll":false,"prompt":"What do you do?"}}\n\nNARRATIVE:\nThe scene waits.`;

      res.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
      res.status(200).send({ text });
    } catch (err) {
      console.error(err);
      res.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
      res.status(500).send({ error: "aiTurn failed" });
    }
  });
});
