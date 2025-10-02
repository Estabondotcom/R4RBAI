const { onCall } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

exports.deleteCampaign = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new Error("UNAUTHENTICATED: Sign in required.");
  }

  const campaignId = request.data?.campaignId;
  if (!campaignId || typeof campaignId !== "string") {
    throw new Error("INVALID_ARGUMENT: campaignId is required.");
  }

  const ref = admin.firestore().collection("campaigns").doc(campaignId);
  const snap = await ref.get();
  if (!snap.exists) {
    return { ok: true, message: "Not found (already deleted)" };
  }

  const data = snap.data();
  if (data.uid !== uid) {
    // you used `uid` on the doc; if you switch to ownerUid, update this check
    throw new Error("PERMISSION_DENIED: Not your campaign.");
  }

  await admin.firestore().recursiveDelete(ref);
  return { ok: true };
});
