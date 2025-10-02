// functions/index.js  (Node 20+; firebase-functions v6)
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2/options";
import admin from "firebase-admin";

admin.initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

export const deleteCampaign = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in required.");
  }

  const campaignId = request.data?.campaignId;
  if (!campaignId || typeof campaignId !== "string") {
    throw new HttpsError("invalid-argument", "campaignId is required.");
  }

  const ref = admin.firestore().collection("campaigns").doc(campaignId);
  const snap = await ref.get();
  if (!snap.exists) {
    return { ok: true, message: "Not found (already deleted)" };
  }

  const data = snap.data();
  // Adjust this field name if you store owner differently (ownerUid, etc.)
  if (data.uid !== uid) {
    throw new HttpsError("permission-denied", "Not your campaign.");
  }

  await admin.firestore().recursiveDelete(ref);
  return { ok: true };
});
