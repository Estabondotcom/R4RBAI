// functions/index.js
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2/options";
import admin from "firebase-admin";
import corsLib from "cors";
import OpenAI from "openai";

admin.initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

/* --- your existing callable (kept) --- */
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

/* --- AI GM HTTPS endpoint --- */
const ALLOWED_ORIGIN = "https://estabondotcom.github.io"; // your site origin
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
      // ✅ Instantiate OpenAI **inside** the handler, after secrets are available
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      const body = req.body || {};
      const system = `
You are the AI GM for "Roll for Rocket Boots".
Reply in two parts:
1) First line: {"ooc":{"need_roll":true|false,"skill":"<Skill>","dieTier":1..4,"difficulty":8..24,"note":"optional","prompt":"optional"}}
2) Then a blank line and "NARRATIVE:" with 2–4 short, evocative paragraphs.

Rules:
- Do NOT roll dice; the client handles mechanics.
- If mechanics.roll_result is provided, set need_roll=false and narrate consequences.
- Keep continuity with state_summary and recent_turns.
      `.trim();

      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        temperature: 0.8,
        max_tokens: 600,
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(body) }
        ]
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
