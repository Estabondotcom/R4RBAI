// campaigns.js

// ----- Firebase imports (CDN v11) -----
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import { 
  getAuth, onAuthStateChanged, signOut 
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";
import {
  getFirestore,
  collection, addDoc, doc,
  query, where, orderBy, onSnapshot,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import {
  getFunctions, httpsCallable
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-functions.js";

import { firebaseConfig } from "./firebaseConfigShim.js";

// ----- Firebase init -----
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
// IMPORTANT: match your Cloud Functions region
const functions = getFunctions(app, "us-central1");

// ----- DOM refs -----
const listEl     = document.getElementById("campaignList");
const createBtn  = document.getElementById("createBtn");
const signOutBtn = document.getElementById("signOutBtn");

// ----- Utils -----
function escapeHtml(s = "") {
  return s.replace(/[&<>]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]));
}
function fmtDate(ts) {
  try {
    if (ts?.toMillis) return new Date(ts.toMillis()).toLocaleString();
  } catch (_) {}
  return new Date().toLocaleString();
}

// Build one campaign card
function renderCampaignItem(id, data) {
  const div = document.createElement("div");
  div.className = "card campaign";

  const title = escapeHtml(data.name || "Untitled Campaign");
  const theme = escapeHtml(data.theme || "—");
  const setting = escapeHtml(data.setting || "—");
  const premise = escapeHtml((data.premise || "").slice(0, 240));
  const updated = fmtDate(data.updatedAt);

  div.innerHTML = `
    <div class="row space-between">
      <h3 class="tight">${title}</h3>
      <div class="tiny muted">Updated: ${updated}</div>
    </div>
    <div class="tiny muted" style="margin:.25rem 0 .5rem 0">
      <span class="badge">${theme}</span>
      <span class="badge">${setting}</span>
    </div>
    <p class="muted">${premise || "—"}</p>
    <div class="row" style="gap:.5rem; margin-top:.5rem">
      <button data-open="${id}">Open</button>
      <button data-delete="${id}" title="Delete campaign">🗑️</button>
      <a href="#" data-copy="${id}" class="tiny">Copy ID</a>
    </div>
  `;

  // Open -> go to play page with ?cid
  div.querySelector("[data-open]").onclick = () => {
    location.href = `play.html?cid=${encodeURIComponent(id)}`;
  };

  // Copy ID
  div.querySelector("[data-copy]").onclick = (e) => {
    e.preventDefault();
    navigator.clipboard?.writeText(id);
    alert("Campaign ID copied.");
  };

  // Delete -> call CF deleteCampaign (cascading)
  div.querySelector("[data-delete]").onclick = async () => {
    const ok = confirm(`Delete campaign “${data.name || "Untitled"}”? This deletes ALL its data and cannot be undone.`);
    if (!ok) return;
    try {
      const callDelete = httpsCallable(functions, "deleteCampaign");
      await callDelete({ campaignId: id });
      // onSnapshot will remove it from the list automatically
    } catch (err) {
      console.error(err);
      alert("Delete failed: " + (err.message || err));
    }
  };

  return div;
}

// Live list for the current user
let unsubscribe = null;
function mountCampaigns(uid) {
  if (unsubscribe) { try { unsubscribe(); } catch(_){} }

  // Filter by owner uid and order by updatedAt desc
  const q = query(
    collection(db, "campaigns"),
    where("uid", "==", uid),
    orderBy("updatedAt", "desc")
  );

  listEl.innerHTML = `<div class="empty">Loading campaigns…</div>`;

  unsubscribe = onSnapshot(q, (snap) => {
    listEl.innerHTML = "";
    if (snap.empty) {
      listEl.innerHTML = `<div class="empty">No campaigns yet. Click “New Campaign” to create one.</div>`;
      return;
    }
    snap.forEach(docSnap => {
      const id = docSnap.id;
      const data = docSnap.data();
      listEl.appendChild(renderCampaignItem(id, data));
    });
  }, (err) => {
    console.error(err);
    listEl.innerHTML = `<div class="empty">Failed to load campaigns.</div>`;
  });
}

// Create new campaign for this user
async function createCampaignFor(uid) {
  await addDoc(collection(db, "campaigns"), {
    uid,                         // owner
    name: "New Campaign",
    theme: "",
    setting: "",
    premise: "",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
}

// Wire top-level buttons (if present)
createBtn && (createBtn.onclick = async () => {
  const user = auth.currentUser;
  if (!user) return alert("Please sign in first.");
  try {
    await createCampaignFor(user.uid);
  } catch (err) {
    console.error(err);
    alert("Create failed: " + (err.message || err));
  }
});

signOutBtn && (signOutBtn.onclick = async () => {
  try {
    await signOut(auth);
    location.href = "index.html";
  } catch (err) {
    console.error(err);
    alert("Sign out failed: " + (err.message || err));
  }
});

// Auth gate -> mount list for the signed-in user
onAuthStateChanged(auth, (user) => {
  if (!user) {
    // You can redirect to login or show a message:
    listEl.innerHTML = `<div class="empty">Please sign in to view your campaigns.</div>`;
    return;
  }
  mountCampaigns(user.uid);
});

