// campaigns.js — COMPLETE REPLACEMENT (draft-first flow)

// ----- Firebase (CDN v11) -----
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";
import {
  getFirestore,
  collection, addDoc,
  query, where, orderBy, onSnapshot,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-functions.js";

import { firebaseConfig } from "./firebaseConfigShim.js";

// ----- Firebase init -----
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app, "us-central1"); // match your CF region

// ----- DOM refs -----
const listEl             = document.getElementById("campaignList");
const signOutBtn         = document.getElementById("signOutBtn");

// Inline “Create Character” (sits inside the campaign setup form area)
const createCharacterInline = document.getElementById("createCharacterInline");
const charSummary            = document.getElementById("charSummary");

// Main campaign form fields
const campaignName    = document.getElementById("campaignName");
const campaignTheme   = document.getElementById("campaignTheme");
const campaignSetting = document.getElementById("campaignSetting");
const campaignPremise = document.getElementById("campaignPremise");
const createCampaignBtn = document.getElementById("createCampaignBtn");

// Character modal & fields
const charModal        = document.getElementById("charModal");
const charForm         = document.getElementById("charForm");
const pcName           = document.getElementById("pcName");
const pcDescription    = document.getElementById("pcDescription");
const pcBackground     = document.getElementById("pcBackground");
const pcImagePreview   = document.getElementById("pcImagePreview");
const pcImageFile      = document.getElementById("pcImageFile");
const pcImageClear     = document.getElementById("pcImageClear");
const pointsRemainingEl= document.getElementById("pointsRemaining");

// ----- Utils -----
function escapeHtml(s = "") { return s.replace(/[&<>]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m])); }
function fmtDate(ts) { try { if (ts?.toMillis) return new Date(ts.toMillis()).toLocaleString(); } catch(_){} return new Date().toLocaleString(); }

// =====================================================
//          Character Draft (modal) state/logic
// =====================================================
const TRAITS     = ["Constitution","Strength","Dexterity","Intelligence","Magic"];
const MAX_PER    = 5;
const START_BASE = { Constitution:1, Strength:1, Dexterity:1, Intelligence:1, Magic:0 };
const POOL       = 8; // spendable on top of START_BASE

let traitValues = { ...START_BASE };
let pointsRemaining = POOL;
let imageDataUrl = "";
let pcDraft = null;  // <-- the in-memory draft we build in the modal

// ----- Modal open/close -----
function openModal() {
  // If there is already a draft, preload it; otherwise reset to defaults
  if (pcDraft) {
    pcName.value        = pcDraft.name || "";
    pcDescription.value = pcDraft.description || "";
    pcBackground.value  = pcDraft.background || "";
    traitValues         = { ...pcDraft.traits };
    imageDataUrl        = pcDraft.portraitDataUrl || "";
    setPreview(imageDataUrl || DEFAULT_IMG);
    pointsRemaining     = POOL - totalExtraSpent();
  } else {
    resetCharForm();
  }

  // NEW: lock background scroll
  document.body.classList.add("modal-open");

  charModal.classList.remove("hidden");
  charModal.setAttribute("aria-hidden", "false");
  pcName?.focus();
}

function closeModal() {
  charModal.classList.add("hidden");
  charModal.setAttribute("aria-hidden", "true");

  // NEW: restore background scroll
  document.body.classList.remove("modal-open");
}

// backdrop + [data-close]
charModal?.addEventListener("click", (e) => {
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

pcImageFile?.addEventListener("change", (e)=>{
  const f = e.target.files?.[0]; if(!f) return;
  const reader = new FileReader();
  reader.onload = () => { imageDataUrl = reader.result; setPreview(imageDataUrl); };
  reader.readAsDataURL(f);
});
pcImageClear?.addEventListener("click", ()=>{
  imageDataUrl = "";
  pcImageFile.value = "";
  setPreview(DEFAULT_IMG);
});

// ----- Trait pips -----
function totalExtraSpent(){
  return TRAITS.reduce((sum,t)=> sum + Math.max(0, traitValues[t] - (START_BASE[t]||0)), 0);
}
function setTraitValue(trait, newVal){
  newVal = Math.max(0, Math.min(MAX_PER, newVal));
  const minBase = START_BASE[trait] || 0;
  if (newVal < minBase) newVal = minBase;

  const current = traitValues[trait];
  const priorSpent = totalExtraSpent();
  const deltaExtra = Math.max(0, newVal - (START_BASE[trait]||0)) - Math.max(0, current - (START_BASE[trait]||0));
  if (priorSpent + deltaExtra > POOL) return; // not enough points

  traitValues[trait] = newVal;
  pointsRemaining = POOL - totalExtraSpent();
  renderPips();
}
function renderPips() {
  TRAITS.forEach(trait=>{
    const wrap = document.querySelector(`[data-pips="${trait}"]`);
    if (!wrap) return;
    wrap.innerHTML = "";
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

// ----- Inline button wiring -----
createCharacterInline && (createCharacterInline.onclick = openModal);

// ----- Modal submit: BUILD DRAFT ONLY (no Firestore write!) -----
charForm?.addEventListener("submit", (e)=>{
  e.preventDefault();
  const name = pcName.value.trim();
  if (!name) { pcName.focus(); return; }

  pcDraft = {
    name,
    description: pcDescription.value.trim(),
    background: pcBackground.value.trim(),
    portraitDataUrl: imageDataUrl || null,
    traits: {
      Constitution: traitValues.Constitution,
      Strength:     traitValues.Strength,
      Dexterity:    traitValues.Dexterity,
      Intelligence: traitValues.Intelligence,
      Magic:        traitValues.Magic
    }
  };

  // Reflect draft under the inline button (optional but helpful)
  if (charSummary) {
    const t = pcDraft.traits;
    charSummary.textContent = `${pcDraft.name} — CON:${t.Constitution} STR:${t.Strength} DEX:${t.Dexterity} INT:${t.Intelligence} MAG:${t.Magic}`;
  }

  closeModal();
});

// =====================================================
//                Create Campaign (writes)
// =====================================================
createCampaignBtn?.addEventListener("click", async ()=>{
  const user = auth.currentUser;
  if (!user) { alert("Please sign in first."); return; }

  if (!pcDraft) {
    alert("Please create a character first.");
    return;
  }

  const name    = (campaignName?.value || "").trim() || `${pcDraft.name}'s Campaign`;
  const theme   = (campaignTheme?.value || "").trim();
  const setting = (campaignSetting?.value || "").trim();
  const premise = (campaignPremise?.value || "").trim();

  const payload = {
    uid: user.uid,
    name,
    theme,
    setting,
    premise,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    pc: pcDraft
  };

  try {
    await addDoc(collection(db, "campaigns"), payload);
    // Optionally clear the draft so users don't accidentally reuse it
    // pcDraft = null;
    // if (charSummary) charSummary.textContent = "No character yet. Click to create.";

    // Optional: quick feedback or redirect
    alert("Campaign created!");
  } catch (err) {
    console.error(err);
    alert("Create failed: " + (err.message || err));
  }
});

// =====================================================
//              Campaign list + delete (CF)
// =====================================================
function renderCampaignItem(id, data) {
  const div = document.createElement("div");
  div.className = "card campaign";
  const title = escapeHtml(data.name || "Untitled Campaign");
  const updated = fmtDate(data.updatedAt);
  const pcLine = data.pc
    ? `${escapeHtml(data.pc.name)} — CON:${data.pc.traits?.Constitution ?? "-"} STR:${data.pc.traits?.Strength ?? "-"} DEX:${data.pc.traits?.Dexterity ?? "-"} INT:${data.pc.traits?.Intelligence ?? "-"} MAG:${data.pc.traits?.Magic ?? "-"}`
    : "—";

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
    e.preventDefault();
    navigator.clipboard?.writeText(id);
    alert("Campaign ID copied.");
  };
  div.querySelector("[data-delete]").onclick = async ()=>{
    const ok = confirm(`Delete campaign “${data.name || "Untitled"}”? This deletes ALL its data and cannot be undone.`);
    if (!ok) return;
    try {
      const callDelete = httpsCallable(functions, "deleteCampaign");
      await callDelete({ campaignId: id });
      // onSnapshot will refresh
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
    if (snap.empty) {
      listEl.innerHTML = `<div class="empty">No campaigns yet. Use “Create Character”, then “Create campaign”.</div>`;
      return;
    }
    snap.forEach(docSnap => listEl.appendChild(renderCampaignItem(docSnap.id, docSnap.data())));
  }, (err)=>{
    console.error(err);
    listEl.innerHTML = `<div class="empty">Failed to load campaigns.</div>`;
  });
}

// ----- Sign out -----
signOutBtn?.addEventListener("click", async ()=>{
  try { await signOut(auth); location.href = "index.html"; }
  catch (e) { console.error(e); alert("Sign out failed."); }
});

// ----- Auth gate -----
onAuthStateChanged(auth, (user)=>{
  if (!user) {
    listEl.innerHTML = `<div class="empty">Please sign in to view your campaigns.</div>`;
    return;
    }
  mountCampaigns(user.uid);
});

// Initialize pips once on load
renderPips();
