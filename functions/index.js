// functions/index.js  (Node 22; firebase-functions v6 ESM)
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2/options";
import admin from "firebase-admin";
import corsLib from "cors";
import OpenAI from "openai";

admin.initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

// ----- Existing: deleteCampaign (kept as-is) -----
export const deleteCampaign = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in required.");

  const campaignId = request.data?.campaignId;
  if (!campaignId || typeof campaignId !== "string") {
    throw new HttpsError("invalid-argument", "campaignId is required.");
  }

  const ref = admin.firestore().collection("campaigns").doc(campaignId);
  const snap = await ref.get();
  if (!snap.exists) return { ok: true, message: "Not found (already deleted)" };

  const data = snap.data();
  if (data.uid !== uid) {
    throw new HttpsError("permission-denied", "Not your campaign.");
  }

  await admin.firestore().recursiveDelete(ref);
  return { ok: true };
});

// ----- New: aiTurn (HTTPS) -----
const ALLOWED_ORIGIN = "https://estabondotcom.github.io"; // your site origin
const cors = corsLib({ origin: ALLOWED_ORIGIN });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
      const body = req.body || {};
      const system = `
You are the AI GM for "Roll for Rocket Boots".
Reply in two parts:
1) First line: a JSON object with key "ooc" ONLY, e.g.:
{"ooc":{"need_roll":true|false,"skill":"<Skill>","dieTier":1..4,"difficulty":8..24,"note":"optional"}}
2) Then a blank line, then:
NARRATIVE:
<2–4 paragraphs of evocative prose>

Rules:
- Do NOT roll dice; the client handles mechanics.
- If you need a roll, set need_roll=true and include skill, dieTier, difficulty.
- If a roll result is provided (body.mechanics.roll_result), set need_roll=false and narrate consequences.
- Keep continuity with body.state_summary and body.recent_turns.
      `.trim();

      const messages = [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(body) }
      ];

      const r = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.8,
        max_tokens: 600,
        messages
      });

      const text =
        r.choices?.[0]?.message?.content?.trim() ||
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
