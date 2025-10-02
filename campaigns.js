// campaigns.js

// ----- Firebase imports (CDN v11) -----
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";
import {
  getFirestore,
  collection, addDoc, doc,
  query, where, orderBy, onSnapshot,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-functions.js";

import { firebaseConfig } from "./firebaseConfigShim.js";

// ----- Firebase init -----
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, "us-central1");

// ----- DOM refs -----
const listEl = document.getElementById("campaignList");
const createCharacterBtn = document.getElementById("createCharacterBtn");
const signOutBtn = document.getElementById("signOutBtn");

// Modal refs
const charModal = document.getElementById("charModal");
const charForm = document.getElementById("charForm");
const pcName = document.getElementById("pcName");
const pcDescription = document.getElementById("pcDescription");
const pcBackground = document.getElementById("pcBackground");
const pcImagePreview = document.getElementById("pcImagePreview");
const pcImageFile = document.getElementById("pcImageFile");
const pcImageClear = document.getElementById("pcImageClear");
const pointsRemainingEl = document.getElementById("pointsRemaining");

// ----- Utils -----
function escapeHtml(s = "") { return s.replace(/[&<>]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m])); }
function fmtDate(ts) { try { if (ts?.toMillis) return new Date(ts.toMillis()).toLocaleString(); } catch(_){} return new Date().toLocaleString(); }

// ===== Character creation state =====
const TRAITS = ["Constitution","Strength","Dexterity","Intelligence","Magic"];
const MAX_PER = 5;
const START_BASE = { Constitution:1, Strength:1, Dexterity:1, Intelligence:1, Magic:0 }; // auto-toggled pips
const POOL = 8; // 8 points to spend in addition to the base above
let pointsRemaining = POOL;
let traitValues = { ...START_BASE };
let imageDataUrl = ""; // store small data URL for now (you can later switch to Firebase Storage)

// ----- Modal open/close -----
function openModal() {
  resetCharForm();
  charModal.classList.remove("hidden");
  charModal.setAttribute("aria-hidden", "false");
  pcName.focus();
}
function closeModal() {
  charModal.classList.add("hidden");
  charModal.setAttribute("aria-hidden", "true");
}

charModal.addEventListener("click", (e)=>{
  if (e.target.matches("[data-close]")) closeModal();
});

// ----- Image handling -----
const DEFAULT_IMG = "data:image/svg+xml;utf8," + encodeURIComponent(`
  <svg xmlns='http://www.w3.org/2000/svg' width='360' height='360'>
    <rect width='100%' height='100%' fill='#0c0c0c'/>
    <text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' fill='#444' font-size='20'>No image</text>
  </svg>`);

function setPreview(src){ pcImagePreview.src = src || DEFAULT_IMG; }
setPreview(DEFAULT_IMG);

pcImageFile.addEventListener("change", async (e)=>{
  const f = e.target.files?.[0]; if(!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    imageDataUrl = reader.result;
    setPreview(imageDataUrl);
  };
  reader.readAsDataURL(f);
});
pcImageClear.addEventListener("click", ()=>{
  imageDataUrl = "";
  pcImageFile.value = "";
  setPreview(DEFAULT_IMG);
});

// ----- Trait pips rendering/logic -----
function renderPips() {
  TRAITS.forEach(trait=>{
    const wrap = document.querySelector(`[data-pips="${trait}"]`);
    wrap.innerHTML = ""; // clear
    for (let i=1;i<=MAX_PER;i++){
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pip" + (traitValues[trait] >= i ? " active" : "");
      b.dataset.trait = trait;
      b.dataset.value = i;
      b.title = `${trait}: set to ${i}`;
      b.onclick = ()=> setTraitValue(trait, i);
      wrap.appendChild(b);
    }
  });
  pointsRemainingEl.textContent = String(pointsRemaining);
}

function totalExtraSpent(){
  // Points beyond the base auto-toggled (START_BASE)
  return TRAITS.reduce((sum,t)=> sum + Math.max(0, traitValues[t] - (START_BASE[t]||0)), 0);
}

function setTraitValue(trait, newVal){
  newVal = Math.max(0, Math.min(MAX_PER, newVal));
  const minBase = START_BASE[trait] || 0;       // min pins (locked floor) for the four base traits
  if (newVal < minBase) newVal = minBase;

  // compute hypothetical spend
  const current = traitValues[trait];
  const priorSpent = totalExtraSpent();
  const deltaExtra = Math.max(0, newVal - (START_BASE[trait]||0)) - Math.max(0, current - (START_BASE[trait]||0));
  if (priorSpent + deltaExtra > POOL) {
    // not enough points
    return;
  }
  traitValues[trait] = newVal;
  pointsRemaining = POOL - totalExtraSpent();
  renderPips();
}

function resetCharForm(){
  pcName.value = "";
  pcDescription.value = "";
  pcBackground.value = "";
  imageDataUrl = "";
  setPreview(DEFAULT_IMG);
  traitValues = { ...START_BASE };
  pointsRemaining = POOL;
  renderPips();
}

// ----- Save -> creates a campaign with embedded PC -----
charForm.addEventListener("submit", async (e)=>{
  e.preventDefault();
  const user = auth.currentUser;
  if (!user) { alert("Please sign in first."); return; }
  if (!pcName.value.trim()) { pcName.focus(); return; }

  const payload = {
    uid: user.uid,                // owner
    name: pcName.value.trim() + "'s Campaign",   // campaign name (tweak as desired)
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    pc: {
      name: pcName.value.trim(),
      description: pcDescription.value.trim(),
      background: pcBackground.value.trim(),
      portraitDataUrl: imageDataUrl || null,
      traits: {
        Constitution: traitValues.Constitution,
        Strength: traitValues.Strength,
        Dexterity: traitValues.Dexterity,
        Intelligence: traitValues.Intelligence,
        Magic: traitValues.Magic
      }
    }
  };

  try {
    await addDoc(collection(db, "campaigns"), payload);
    closeModal();
  } catch (err) {
    console.error(err);
    alert("Failed to create character: " + (err.message || err));
  }
});

// ===== Campaign list (unchanged) + delete via CF =====
function renderCampaignItem(id, data) {
  const div = document.createElement("div");
  div.className = "card campaign";
  const title = escapeHtml(data.name || "Untitled Campaign");
  const updated = fmtDate(data.updatedAt);
  const pcLine = data.pc ? `${escapeHtml(data.pc.name)} — CON:${data.pc.traits?.Constitution ?? "-"} STR:${data.pc.traits?.Strength ?? "-"} DEX:${data.pc.traits?.Dexterity ?? "-"} INT:${data.pc.traits?.Intelligence ?? "-"} MAG:${data.pc.traits?.Magic ?? "-"}` : "—";

  div.innerHTML = `
    <div class="row space-between">
      <h3 class="tight">${title}</h3>
      <div class="tiny muted">Updated: ${updated}</div>
    </div>
    <div class="tiny muted" style="margin:.25rem 0 .5rem 0">${pcLine}</div>
    <div class="row" style="gap:.5rem">
      <button data-open="${id}">Open</button>
      <button data-delete="${id}" title="Delete campaign">🗑️</button>
      <a href="#" data-copy="${id}" class="tiny">Copy ID</a>
    </div>
  `;

  div.querySelector("[data-open]").onclick = () => {
    location.href = `play.html?cid=${encodeURIComponent(id)}`;
  };
  div.querySelector("[data-copy]").onclick = (e)=>{
    e.preventDefault(); navigator.clipboard?.writeText(id); alert("Campaign ID copied.");
  };
  div.querySelector("[data-delete]").onclick = async ()=>{
    const ok = confirm(`Delete campaign “${data.name || "Untitled"}”? This deletes ALL its data and cannot be undone.`);
    if (!ok) return;
    try {
      const callDelete = httpsCallable(functions, "deleteCampaign");
      await callDelete({ campaignId: id });
    } catch (err) {
      console.error(err);
      alert("Delete failed: " + (err.message || err));
    }
  };

  return div;
}

let unsubscribe = null;
function mountCampaigns(uid){
  if (unsubscribe) { try { unsubscribe(); } catch(_){} }
  const q = query(collection(db, "campaigns"), where("uid","==",uid), orderBy("updatedAt","desc"));
  listEl.innerHTML = `<div class="empty">Loading campaigns…</div>`;
  unsubscribe = onSnapshot(q, (snap)=>{
    listEl.innerHTML = "";
    if (snap.empty) { listEl.innerHTML = `<div class="empty">No campaigns yet. Click “Create Character”.</div>`; return; }
    snap.forEach(docSnap => listEl.appendChild(renderCampaignItem(docSnap.id, docSnap.data())));
  }, (err)=>{
    console.error(err);
    listEl.innerHTML = `<div class="empty">Failed to load campaigns.</div>`;
  });
}

// ----- Wire buttons & auth -----
createCharacterBtn && (createCharacterBtn.onclick = openModal);
signOutBtn && (signOutBtn.onclick = async ()=>{ try { await signOut(auth); location.href="index.html"; } catch(e){ alert("Sign out failed."); } });

onAuthStateChanged(auth, (user)=>{
  if (!user){ listEl.innerHTML = `<div class="empty">Please sign in to view your campaigns.</div>`; return; }
  mountCampaigns(user.uid);
});

// init pips once
renderPips();
