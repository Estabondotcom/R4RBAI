// ---------- Minimal client state ----------
const state = {
  campaign: { id: "", title: "", theme: "", setting: "", premise: "" },
  campaignId: crypto.randomUUID(),
  pc: {
    name: "",
    description: "",
    background: "",
    wounds: 0,          // 0..4 (0 = all hearts full, 4 = all empty)
    luck: 0,            // numeric (we'll set to 1 at session start)
    xp: 0,              // numeric
    statuses: [],
    traits: null,
    portraitDataUrl: "",
    // 'tier' == Level (1..4). Dice = level + 1 (L1=2d6 ... L4=5d6)
    skills: []          // empty; "Do Anything" is added dynamically
  },
  inv: [],              // empty; Firestore/starter kit will populate
  rollPending: null,
  testRolling: false,
  pendingReroll: null,
  storySummary: "",        // rolling recap the AI can read
  isReplayingHistory: false,
  pendingLoot: null        // ✨ NEW: holds proposed items awaiting player choice
};

// ---------- DOM refs ----------
const bookEl = document.getElementById("book");
const dockEl = document.getElementById("dockMessages");
const rollHint = document.getElementById("rollHint");
const scrollLock = document.getElementById("scrollLock");

// ---------- AI Config ----------
const USE_AI = true;
// Your deployed AI endpoint (use the Firebase Function so prompt rules apply):
const AI_URL = "https://aiturn-gyp3ryw5ga-uc.a.run.app"; // ✨ NEW

async function callAiTurn(payload){
  const res = await fetch(AI_URL, {
    method: "POST",
    headers: { "Content-Type":"application/json" },
    body: JSON.stringify(payload)
  });
  if(!res.ok){
    const t = await res.text().catch(()=> "");
    throw new Error(`aiTurn failed (${res.status}): ${t}`);
  }
  const { text } = await res.json();
  return text;
}

function buildStateSummary(){
  return {
    campaign: {
      id: state.campaign?.id || "",
      title: state.campaign?.title || "",
      theme: state.campaign?.theme || "",
      setting: state.campaign?.setting || "",
      premise: state.campaign?.premise || ""
    },
    pc: {
      name: state.pc.name,
      description: state.pc.description || "",
      background: state.pc.background || "",
      xp: state.pc.xp,
      luck: state.pc.luck,
      wounds: state.pc.wounds,
      statuses: state.pc.statuses,
      portrait: !!state.pc.portraitDataUrl,
      traits: state.pc.traits || null,
      skills: state.pc.skills.map(s=>({ name: s.name, level: s.tier, traits: s.traits||[] }))
    },
    inventory: state.inv
  };
}

function buildCampaignCard(){
  const { campaign, pc } = state;
  return {
    title: campaign.title || "Untitled Campaign",
    theme: campaign.theme || "",
    setting: campaign.setting || "",
    premise: campaign.premise || "",
    pc: {
      name: pc.name || "",
      background: pc.background || "",
      description: pc.description || "",
      statuses: Array.isArray(pc.statuses) ? pc.statuses : [],
      traits: pc.traits || null
    }
  };
}

// ---------- Firestore / Firebase ----------
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore, doc, getDoc,
  collection, addDoc, getDocs, query, orderBy, limit,
  setDoc, serverTimestamp, updateDoc
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const fbApp = getApps().length ? getApps()[0] : initializeApp({
  apiKey: "AIzaSyCV8U5deVGvGBHn00DtnX6xkkNZJ2895Qo",
  authDomain: "r4rbai.firebaseapp.com",
  projectId: "r4rbai"
});
const db = getFirestore(fbApp);
const auth = getAuth(fbApp);

// ---------- Firestore helpers (campaign + turns) ----------
function campaignDocRef() {
  const id = state.campaign?.id || state.campaignId;
  return doc(db, "campaigns", id);
}

async function ensureCampaignDoc() {
  const ref = campaignDocRef();
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      title: state.campaign?.title || "",
      theme: state.campaign?.theme || "",
      setting: state.campaign?.setting || "",
      premise: state.campaign?.premise || "",
      storySummary: state.storySummary || "",
      createdAt: serverTimestamp()
    }, { merge: true });
  }
}
// Save the current PC (including skills) and inventory into the campaign doc
async function savePcSnapshot(extra = {}) {
  const ref = campaignDocRef();
  const pc = {
    name: String(state.pc.name || ""),
    description: String(state.pc.description || ""),
    background: String(state.pc.background || ""),
    portraitDataUrl: String(state.pc.portraitDataUrl || ""),
    xp: Number(state.pc.xp || 0),
    luck: Number(state.pc.luck || 0),
    wounds: Number(state.pc.wounds || 0),
    statuses: Array.isArray(state.pc.statuses) ? state.pc.statuses.map(String) : [],
    traits: state.pc.traits || null,
    skills: (state.pc.skills || []).map(s => ({
      name: String(s.name || ""),
      tier: Math.max(1, Math.min(4, Number(s.tier || 1))),
      traits: sanitizeTraitList(s.traits, 2)
    }))
  };
  const inv = (state.inv || []).map(it => ({
    name: String(it.name || ""),
    qty: Math.max(1, Number(it.qty || 1)),
    matches: sanitizeTraitList(it.matches, 2)
  }));

  await setDoc(ref, { pc, inv, updatedAt: serverTimestamp(), ...extra }, { merge: true });
}
async function saveTurn(role, text, extras = {}) {
  if (!state.campaign?.id && !state.campaignId) return;
  const ref = collection(db, "campaigns", state.campaign?.id || state.campaignId, "turns");
  await addDoc(ref, {
    role,
    text,
    ...extras,
    createdAtMs: Date.now(),
    createdAt: serverTimestamp()
  });
  // consider refreshing the rolling summary
  maybeUpdateStorySummary();
}

// returns count of turns loaded (replay history without animation, in strict order)
async function loadTurnsAndRender() {
  if (!state.campaign?.id && !state.campaignId) return 0;
  state.isReplayingHistory = true;

  const ref = collection(db, "campaigns", state.campaign?.id || state.campaignId, "turns");
  const snap = await getDocs(ref);

  // Build array and sort by our stable keys
  const turns = [];
  snap.forEach(docSnap => {
    const t = docSnap.data() || {};
    const ms = typeof t.createdAtMs === "number" ? t.createdAtMs
             : (t.createdAt?.toMillis?.() || 0);
    turns.push({ ms, role: t.role || "system", text: t.text || "", raw: t });
  });
  turns.sort((a,b) => a.ms - b.ms);

  // Clear UI, then replay WITHOUT animation
  bookEl.innerHTML = "";
  dockEl.innerHTML = "";

  let count = 0;
  for (const t of turns) {
    count++;
    switch (t.role) {
      case "you":
        postDock("you", t.text);
        break;
      case "ooc":
        postDock("dm", t.text);
        break;
      case "dm":
        appendToBookImmediate(t.text);   // no typing on history
        break;
      case "system":
      case "roll":
      default:
        postDock(t.role, t.text);
    }
  }

  state.isReplayingHistory = false;
  return count;
}

// Get the last N turns and return as [{role, text}] oldest→newest
async function getRecentTurnsForAI(n = 8) {
  const id = state.campaign?.id || state.campaignId;
  if (!id) return [];
  const ref = collection(db, "campaigns", id, "turns");

  // newest-first by client millis, then reverse
  const q = query(ref, orderBy("createdAtMs", "desc"), limit(n));
  const snap = await getDocs(q);

  const buf = [];
  snap.forEach(s => {
    const t = s.data() || {};
    if (t.role === "you" || t.role === "ooc" || t.role === "dm") {
      buf.push({ role: t.role, text: String(t.text || "") });
    }
  });
  return buf.reverse();
}

// rolling story summary (recap every ~10 saved turns)
const SUMMARY_EVERY_N_TURNS = 10;
let _turnsSinceSummary = 0;

async function maybeUpdateStorySummary() {
  if (state.isReplayingHistory) return; // never summarize during history load
  _turnsSinceSummary++;
  if (_turnsSinceSummary < SUMMARY_EVERY_N_TURNS) return;

  const recent = await getRecentTurnsForAI(30);
  const prompt = [
    "You are the campaign scribe. Produce an objective recap of the story so far.",
    "Keep 120–200 words. No spoilers for hidden info. Include named NPCs, locations, goals, and open threads.",
    "",
    "Existing summary (may be empty):",
    state.storySummary || "(none)",
    "",
    "Recent log (role: text):",
    ...recent.map(t => `- ${t.role}: ${t.text}`)
  ].join("\n");

  let text = "";
  try {
    text = await callAiTurn({
      kickoff: false,
      state_summary: buildStateSummary(),
      campaign_card: buildCampaignCard(),
      player_input: prompt
    });
  } catch (e) {
    console.warn("Summary AI failed:", e);
    _turnsSinceSummary = 0;
    return;
  }

  const newSummary = String(text || "").trim();
  if (!newSummary) { _turnsSinceSummary = 0; return; }

  state.storySummary = newSummary;
  try {
    await updateDoc(campaignDocRef(), { storySummary: newSummary });
  } catch (e) {
    console.warn("Failed to save storySummary:", e);
  }

  _turnsSinceSummary = 0;
  postDock("system", "Story summary updated.");
  ensureCampaignDoc().then(()=> saveTurn("system", "Story summary updated."));
}

// ---------- Rules loading/compilation ----------
let RULES = null;

function defaultRules(){
  return {
    crit_margin: 10,
    dice_by_level: {1:2,2:3,3:4,4:5},
    xp_on_fail: 1,
    xp_cost_next: {1:2,2:3,3:4,4:5},
    all_sixes_explodes: true,
    difficulty_scale: [],
    luck: { start:1, reroll:"lowest_d6", xp_cost:2 },
    wounds: { levels:4, penalty_at_or_above:2, penalty_value:-3 },
    statuses: {},
    items: {}
  };
}

async function loadRules(){
  try{
    const res = await fetch("modrules.json");
    if(!res.ok) throw new Error(res.statusText);
    const raw = await res.json();
    RULES = {
      ...defaultRules(),
      ...raw,
      dice_by_level: Object.fromEntries(
        Object.entries(raw.dice_by_level||raw["dice_by_level"]||{}).map(([k,v])=>[+k, +v])
      )
    };
  }catch(e){
    console.warn("Failed to load modrules.json; using defaults.", e);
    RULES = defaultRules();
  }
}

// Strip code fences/OOC and extract the first complete JSON object
function extractFirstJsonObject(str){
  if (!str) return "";
  str = str.replace(/```json\s*([\s\S]*?)\s*```/gi, "$1")
           .replace(/```\s*([\s\S]*?)\s*```/g, "$1");
  let brace = 0, start = -1;
  for (let i = 0; i < str.length; i++){
    const ch = str[i];
    if (ch === '{'){
      if (brace === 0) start = i;
      brace++;
    } else if (ch === '}'){
      brace--;
      if (brace === 0 && start !== -1){
        return str.slice(start, i + 1);
      }
    }
  }
  return "";
}

function diceForLevel(level){
  const map = (RULES && RULES.dice_by_level) || {1:2,2:3,3:4,4:5};
  const n = map[level] ?? (level+1);
  return Math.max(1, Math.min(6, n));
}
function xpCostToNext(level){ return RULES?.xp_cost_next?.[level] ?? (level >= 4 ? 5 : (level + 1)); }

// Traits helpers
function skillTraits(skill){
  return Array.isArray(skill.traits) ? skill.traits.map(t=>String(t).toLowerCase()) : [];
}

function computeModsForSkill(skill){
  let mod = 0;
  const details = [];
  const traits = skillTraits(skill);

  // Wounds penalty
  if (RULES?.wounds && state.pc.wounds >= (RULES.wounds.penalty_at_or_above ?? 2)) {
    const v = RULES.wounds.penalty_value ?? -3;
    mod += v; details.push(`wounds ${v}`);
  }

  // Status effects via RULES.statuses
  for (const s of (state.pc.statuses || [])) {
    const defs = RULES.statuses?.[String(s).toLowerCase()];
    if (!defs) continue;
    for (const [tag,val] of Object.entries(defs)) {
      if (traits.includes(tag.toLowerCase())) { mod += val; details.push(`${s} ${val}`); }
    }
  }

  // Item bonuses via RULES.items and item.matches tags (+1 each match)
  for (const it of (state.inv || [])) {
    const qty = it.qty || 1;
    const defs = RULES.items?.[String(it.name||"").toLowerCase()];
    if (defs) {
      for (const [tag,val] of Object.entries(defs)) {
        if (traits.includes(tag.toLowerCase())) { mod += (val * qty); details.push(`${it.name} ${val*qty}`); }
      }
    }
    if (Array.isArray(it.matches) && it.matches.length) {
      for (const tag of it.matches) {
        if (traits.includes(String(tag).toLowerCase())) { mod += 1; details.push(`${it.name} +1`); }
      }
    }
  }

  return { mod, details };
}

function d6(){ return Math.floor(Math.random()*6)+1; }
// ---------- Trait pool (authoritative) ----------
const TRAIT_POOL = [
  "Acrobatics","Agility","Aim","Athletics","Charm","Climb","Combat","Constitution","Crafting",
  "Deception","Endurance","Exploration","Explosive","Flashy","Focus","Improv","Insight","Intimidate",
  "Logic","Loud","Magic","Memory","Occult","Perception","Performance","Persuasion","Reflex","Religion",
  "Social","Stealth","Survival","Swim","Tactics","Tech","Violent"
];

// Lowercased set for quick membership checks, but we keep UI labels capitalized.
const TRAIT_SET_LOWER = new Set(TRAIT_POOL.map(t => t.toLowerCase()));

function isAllowedTrait(t){
  return TRAIT_SET_LOWER.has(String(t).toLowerCase());
}

// Normalize -> lowercase, filter to allowed, unique, and cap to N (default 2)
function sanitizeTraitList(arr, max=2){
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(arr) ? arr : [])) {
    const t = String(raw).toLowerCase();
    if (TRAIT_SET_LOWER.has(t) && !seen.has(t)) {
      out.push(t);
      seen.add(t);
      if (out.length >= max) break;
    }
  }
  return out;
}

// ---------- Trait Picker Modal Helper ----------
async function openTraitPicker({ title = "Choose Traits", max = 2 } = {}) {
  return new Promise((resolve) => {
    // Create overlay
    const overlay = document.createElement("div");
    overlay.className = "trait-picker-overlay";
    overlay.innerHTML = `
      <div class="trait-picker">
        <h3>${title}</h3>
        <div class="trait-grid">
          ${TRAIT_POOL.map(t => `
            <label class="trait-option">
              <input type="checkbox" value="${t.toLowerCase()}">
              <span>${t}</span>
            </label>`).join("")}
        </div>
        <div class="trait-actions">
          <button id="traitConfirm">Confirm</button>
          <button id="traitCancel">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const checkboxes = overlay.querySelectorAll("input[type=checkbox]");
    checkboxes.forEach(cb => {
      cb.addEventListener("change", () => {
        const checked = overlay.querySelectorAll("input[type=checkbox]:checked");
        if (checked.length > max) cb.checked = false;
      });
    });

    overlay.querySelector("#traitConfirm").onclick = () => {
      const selected = [...overlay.querySelectorAll("input:checked")].map(cb => cb.value);
      overlay.remove();
      resolve(selected);
    };
    overlay.querySelector("#traitCancel").onclick = () => {
      overlay.remove();
      resolve(null);
    };
  });
}

function ensureDoAnything(){
  if (!state.pc.skills.some(s => s.name === "Do Anything")) {
    state.pc.skills.unshift({ name: "Do Anything", tier: 1, traits: ["improv"] });
  }
}

async function levelUpSkill(skill){
  if (skill.name === "Do Anything") {
    postDock("system", `"Do Anything" cannot be leveled.`);
    return;
  }

  if (skill.tier < 4) {
    skill.tier += 1;
    postDock("system", `${skill.name} leveled up to Level ${skill.tier}.`);
    ensureCampaignDoc().then(()=> saveTurn("system", `${skill.name} leveled to ${skill.tier}`));

    // ✨ persist the updated PC (including skills)
    await savePcSnapshot();
  } else {
    // unlock specialization
    const base = skill.name.replace(/\s*\(Spec.*\)$/,'');
    const specName = prompt(
      `Create a specialization for "${base}" (e.g., "${base}: Rooftop Parkour")`,
      `${base}: Specialization`
    ) || `${base}: Specialization`;

    state.pc.skills.push({ name: specName, tier: 1, traits: skillTraits(skill) });
    postDock("system", `Unlocked specialization: ${specName} (Level 1).`);
    ensureCampaignDoc().then(()=> saveTurn("system", `Unlocked specialization: ${specName}`));

    // ✨ persist with the new specialization added
    await savePcSnapshot();
  }

  renderSkills();
}

async function maybeCreateNewSkillFromDoAnything(){
  const name = prompt("Success with Do Anything! Name the new related skill (Level 1):", "");
  if (!name) return;

  if (state.pc.skills.some(s => s.name.toLowerCase() === name.toLowerCase())) {
    postDock("system", `Skill "${name}" already exists.`);
    ensureCampaignDoc().then(()=> saveTurn("system", `Skill "${name}" already exists (Do Anything).`));
    return;
  }

  // Open the picker (choose up to 2 traits from the pool)
  const picked = await openTraitPicker({ title: `Choose traits for "${name}"`, max: 2 });
  if (!picked) { postDock("system", "Cancelled skill creation."); return; }

  const traits = sanitizeTraitList(picked, 2); // lowercase + validated
  if (traits.length === 0) {
    postDock("system", "No valid traits selected; skill not created.");
    return;
  }

  state.pc.skills.push({ name, tier: 1, traits });
  postDock("system", `New skill created: ${name} (Level 1) — traits: ${traits.join(", ") || "—"}.`);
  ensureCampaignDoc().then(()=> saveTurn("system", `New skill created: ${name} (L1) traits=${traits.join(", ")||"—"}`));

  renderSkills();
  await savePcSnapshot();
}

// ---------- Right tray wiring ----------
const tray = document.getElementById("tray");
document.getElementById("trayToggle").onclick = () => tray.classList.toggle("open");

document.getElementById("tabs").onclick = (e) => {
  if (e.target.tagName !== "BUTTON") return;
  [...document.querySelectorAll(".tabs button")].forEach((b) => b.classList.remove("active"));
  e.target.classList.add("active");
  const map = { skills: "panel-skills", inv: "panel-inv", health: "panel-health" };
  Object.values(map).forEach((id) => (document.getElementById(id).style.display = "none"));
  document.getElementById(map[e.target.dataset.tab]).style.display = "block";
};

// ---------- Skills UI ----------
function renderSkills(){
  ensureDoAnything();

  const wrap = document.getElementById("panel-skills");
  wrap.innerHTML = "";

  (state.pc.skills || []).forEach((s) => {
    const level = Number(s.tier || 1);
    const diceN = diceForLevel(level);
    const cost = xpCostToNext(level);
    const enoughXP = (state.pc.xp || 0) >= cost;
    const isDoAnything = s.name === "Do Anything";

    const row = document.createElement("div");
    row.className = "skill";
    row.innerHTML = `
      <button type="button" class="skillRollBtn" data-skill="${escapeHtml(s.name)}">
        ${escapeHtml(s.name)}
      </button>
      <div class="skillMeta">
        <span class="pill">Level ${level}</span>
        <span class="pill">${diceN}d6</span>
        ${
          (Array.isArray(s.traits) && s.traits.length)
            ? s.traits.map(t => `<span class="pill soft">${escapeHtml(String(t))}</span>`).join("")
            : ""
        }
      </div>
      <div class="skillActions"></div>
    `;

    // Roll handler
    row.querySelector(".skillRollBtn")?.addEventListener("click", () => {
      triggerRoll(s);
    });

    // Actions (level up / specialize)
    const actions = row.querySelector(".skillActions");
    if (isDoAnything) {
      actions.innerHTML = `<button type="button" class="btn-soft tiny" disabled title="Cannot level Do Anything">Locked</button>`;
    } else if (level < 4) {
      actions.innerHTML = `
        <button
          type="button"
          class="btn-soft tiny"
          data-levelup
          ${enoughXP ? "" : "disabled"}
          title="${enoughXP ? `Spend ${cost} XP to reach Level ${level+1}` : `Need ${cost} XP`}"
        >
          Level Up (${cost} XP)
        </button>
      `;

      const btn = actions.querySelector("[data-levelup]");
      btn && btn.addEventListener("click", async () => {
        const need = xpCostToNext(s.tier);
        if ((state.pc.xp || 0) < need) {
          postDock("system", `Need ${need} XP to level up ${s.name}. You have ${state.pc.xp}.`);
          ensureCampaignDoc().then(() => saveTurn("system", `Insufficient XP to level ${s.name}`));
          return;
        }
        // prevent double-click
        btn.disabled = true;

        state.pc.xp -= need;
        await levelUpSkill(s);     // async; persists via savePcSnapshot() inside
        renderHealth();
        renderSkills();
      });

    } else {
      // level >= 4 → Specialization
      actions.innerHTML = `
        <button
          type="button"
          class="btn-soft tiny"
          data-special
          ${enoughXP ? "" : "disabled"}
          title="${enoughXP ? `Spend ${cost} XP to unlock a specialization` : `Need ${cost} XP`}"
        >
          Specialize (${cost} XP)
        </button>
      `;

      const btn = actions.querySelector("[data-special]");
      btn && btn.addEventListener("click", async () => {
        const need = xpCostToNext(s.tier);
        if ((state.pc.xp || 0) < need) {
          postDock("system", `Need ${need} XP to unlock a specialization for ${s.name}. You have ${state.pc.xp}.`);
          ensureCampaignDoc().then(() => saveTurn("system", `Insufficient XP to specialize ${s.name}`));
          return;
        }
        btn.disabled = true;

        state.pc.xp -= need;
        await levelUpSkill(s);     // async; persists via savePcSnapshot() inside
        renderHealth();
        renderSkills();
      });
    }

    wrap.appendChild(row);
  });
}

function renderInv(){
  const el = document.getElementById("invList");
  if (!state.inv || state.inv.length === 0) {
    el.innerHTML = "—";
    return;
  }
  el.innerHTML = state.inv.map(it => {
    const tags = Array.isArray(it.matches) && it.matches.length
      ? it.matches.map(t => `<span class="pill soft">${escapeHtml(t)}</span>`).join("")
      : "";
    return `
      <div class="invRow" style="display:flex;align-items:center;gap:8px;margin:4px 0;">
        <span class="name">• ${escapeHtml(it.name)} ×${it.qty}</span>
        <span class="tags" style="display:flex;gap:6px;flex-wrap:wrap;">${tags}</span>
      </div>
    `;
  }).join("");
}

// ---------- Health panel ----------
const HEARTS_MAX = 4;
function renderHealth(){
  const panel = document.getElementById("panel-health");
  panel.innerHTML = `
    <div class="charCard">
      <div class="portraitBox">
        ${state.pc.portraitDataUrl
          ? `<img class="portrait" src="${state.pc.portraitDataUrl}" alt="Portrait">`
          : `<div class="portrait placeholder">Portrait</div>`}
      </div>
      <div class="rows">
        <div class="nameRow"><h3 class="pcName">${escapeHtml(state.pc.name||"—")}</h3></div>
        <div class="row"><span class="label">Wounds</span><span id="woundsRow" class="icons"></span></div>
        <div class="row"><span class="label">XP</span><span class="value" id="xpVal">${state.pc.xp}</span></div>
        <div class="row"><span class="label">Luck</span><span class="value" id="luckVal">${state.pc.luck}</span></div>
        <div class="row"><button type="button" id="buyLuckBtn" class="btn-soft tiny">Buy 1 Luck (${RULES?.luck?.xp_cost ?? 2} XP)</button></div>
        <div class="row"><span class="label">Statuses</span><span id="statuses" class="value">${state.pc.statuses.join(", ")||"—"}</span></div>
      </div>
    </div>
  `;
  const W = document.getElementById("woundsRow");
  W.innerHTML="";
  const heartsFilled = Math.max(0, HEARTS_MAX - state.pc.wounds);
  for(let i=0;i<HEARTS_MAX;i++){
    const h=document.createElement("span");
    h.className="pill heart";
    h.textContent = i<heartsFilled ? "♥" : "♡";
    W.appendChild(h);
  }

  const buyBtn = document.getElementById("buyLuckBtn");
  if (buyBtn) {
    buyBtn.addEventListener("click", ()=>{
      const cost = RULES?.luck?.xp_cost ?? 2;
      if(state.pc.xp < cost){
        postDock("system",`Not enough XP to buy Luck (need ${cost} XP).`);
        ensureCampaignDoc().then(()=> saveTurn("system",`Not enough XP to buy Luck (${cost})`));
        return;
      }
      state.pc.xp -= cost;
      state.pc.luck += 1;
      postDock("system",`Spent ${cost} XP → +1 Luck.`);
      ensureCampaignDoc().then(()=> saveTurn("system",`Bought 1 Luck for ${cost} XP`));
      renderHealth();
      renderSkills();
    });
  }
}

// ---------- Book typing effect ----------
function appendToBook(text){
  const paragraphs=text.trim().split(/\n{2,}/); let idx=0;
  function typeNextPara(){
    if(idx>=paragraphs.length) return;
    const p=document.createElement("p"); p.className="fade-in"; bookEl.appendChild(p);
    typewriter(paragraphs[idx]+"\n",p,10,()=>{ idx++; if(!scrollLock.checked){ p.scrollIntoView({behavior:"smooth",block:"end"}); } typeNextPara(); });
  }
  typeNextPara();
}
function appendToBookImmediate(text){
  const paragraphs = String(text || "").trim().split(/\n{2,}/);
  for (const para of paragraphs) {
    const p = document.createElement("p");
    p.textContent = para;
    bookEl.appendChild(p);
  }
}
function typewriter(str,node,speed=12,done){
  let i=0;(function tick(){ node.textContent+=str[i++]||""; if(!scrollLock.checked) node.parentElement.scrollTop=node.parentElement.scrollHeight;
    if(i<str.length){ setTimeout(tick,Math.max(6,speed)); } else done&&done(); })();
}

// ---------- Chat Dock ----------
function postDock(role,text){
  const div=document.createElement("div");
  div.className="msg";
  div.innerHTML=`<span class='tag'>[${escapeHtml(role)}]</span>${escapeHtml(text)}`;
  dockEl.appendChild(div);
  dockEl.scrollTop=dockEl.scrollHeight;
  return div;
}
function escapeHtml(s){ return String(s).replace(/[&<>]/g,c=>({ "&":"&amp;","<":"&lt;",">":"&gt;" }[c])); }

// ---------- Commands ----------
function handleCommand(raw){
  // NEW: *ooc- ...*  -> force an OOC-only response (no narration)
  const mOOC = raw.match(/^\*ooc-\s*(.+)\*$/i);
  if (mOOC) {
    const oocText = mOOC[1].trim();
    postDock("you", `(OOC) ${oocText}`);
    ensureCampaignDoc().then(()=> saveTurn("you", `(OOC) ${oocText}`));

    (async () => {
      const recent = await getRecentTurnsForAI(6);
      // Tell the AI to output ONLY the OOC first line (no NARRATIVE)
      aiTurnHandler({
        recent_turns: recent,
        story_summary: state.storySummary || "",
        player_input: [
          "Respond ONLY with the first-line OOC JSON.",
          "Set need_roll=false unless a roll is truly required.",
          `Use this OOC prompt text: ${oocText}`,
          "Do NOT include NARRATIVE."
        ].join("\n"),
        meta: { suppressNarrative: true } // client-side guard
      });
    })();

    return true;
  }

  const m=raw.match(/^\*(\w+)(?:\s+(-?\d+))?\*$/i); if(!m) return false;
  const cmd=m[1].toLowerCase(); const argN=m[2]!=null?parseInt(m[2],10):null;
  const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));

  // *addstatus drunk* / *removestatus drunk*
  const mStatus = raw.match(/^\*(addstatus|removestatus)\s+(.+)\*$/i);
  if (mStatus) {
    const action = mStatus[1].toLowerCase();
    const name = mStatus[2].trim();
    if (name) {
      if (action === "addstatus") {
        if (!state.pc.statuses.includes(name)) state.pc.statuses.push(name);
        postDock("system", `Status added: ${name}`);
        ensureCampaignDoc().then(()=> saveTurn("system", `Status added: ${name}`));
      } else {
        state.pc.statuses = state.pc.statuses.filter(s=>s.toLowerCase()!==name.toLowerCase());
        postDock("system", `Status removed: ${name}`);
        ensureCampaignDoc().then(()=> saveTurn("system", `Status removed: ${name}`));
      }
      renderHealth();
    }
    return true;
  }

  switch(cmd){
    // NEW: *promptadditem*  -> ask AI to propose 1 item via inventory_proposal (no narration)
    case "promptadditem": {
      postDock("system", "Requesting loot proposal…");
      ensureCampaignDoc().then(()=> saveTurn("system", "Requested loot proposal."));
      const allowedListCsv = TRAIT_POOL.join(", ");

      (async () => {
        const recent = await getRecentTurnsForAI(6);
        aiTurnHandler({
          recent_turns: recent,
          story_summary: state.storySummary || "",
          // Ask the GM to propose exactly one item as an inventory_proposal
          player_input: [
            "Propose EXACTLY 1 item using inventory_proposal.add.",
            "Include fields: name, qty (1), matches (1–2 from the allowed list), and a short 'why'.",
            "Use the OOC 'prompt' to ask the player if they want it.",
            "Do NOT auto-add items; no 'inventory' block—proposal only.",
            "Return ONLY the first-line OOC JSON; omit NARRATIVE.",
            "",
            "Allowed traits:",
            allowedListCsv
          ].join("\n"),
          meta: { suppressNarrative: true } // client-side guard
        });
      })();

      return true;
    }

    case "addluck":
      state.pc.luck += 1; renderHealth(); postDock("system",`Luck +1 → ${state.pc.luck}`); ensureCampaignDoc().then(()=> saveTurn("system",`Luck +1`)); return true;
    case "removeluck":
      state.pc.luck = Math.max(0, state.pc.luck - 1); renderHealth(); postDock("system",`Luck -1 → ${state.pc.luck}`); ensureCampaignDoc().then(()=> saveTurn("system",`Luck -1`)); return true;
    case "addwound":
      state.pc.wounds = clamp(state.pc.wounds + 1, 0, HEARTS_MAX); renderHealth(); postDock("system",`Wound +1 → ${state.pc.wounds}/${HEARTS_MAX}`); ensureCampaignDoc().then(()=> saveTurn("system",`Wound +1`)); return true;
    case "removewound":
      state.pc.wounds = clamp(state.pc.wounds - 1, 0, HEARTS_MAX); renderHealth(); postDock("system",`Wound -1 → ${state.pc.wounds}/${HEARTS_MAX}`); ensureCampaignDoc().then(()=> saveTurn("system",`Wound -1`)); return true;
    case "addxp": {
      const n = Number.isFinite(argN) ? argN : 1;
      state.pc.xp = Math.max(0, state.pc.xp + n);
      renderHealth();
      renderSkills();
      const msg = `XP ${n>=0?"+":""}${n} → ${state.pc.xp}`;
      postDock("system", msg);
      ensureCampaignDoc().then(()=> saveTurn("system", msg));
      return true;
    }
    case "newsession":
      state.pc.luck = RULES?.luck?.start ?? 1;
      postDock("system",`New session: Luck reset to ${state.pc.luck}.`);
      ensureCampaignDoc().then(()=> saveTurn("system",`New session: Luck ${state.pc.luck}`));
      renderHealth();
      return true;
    case "togglerolling":
      state.testRolling = !state.testRolling;
      if(state.testRolling){
        state.rollPending = { skill:"Test", difficulty:14, aid:0 };
        rollHint.style.display='inline-block';
        postDock('system','Test rolling: ON — tap any Skill name to roll vs DC 14. (No narration in test mode.)');
      } else {
        state.rollPending = null;
        rollHint.style.display='none';
        postDock('system','Test rolling: OFF');
      }
      return true;
    case "summary":
      postDock("system", state.storySummary || "(no summary yet)");
      ensureCampaignDoc().then(()=> saveTurn("system","(requested summary)"));
      return true;
    default:
      postDock("system",`Unknown command: ${cmd}`);
      ensureCampaignDoc().then(()=> saveTurn("system",`Unknown command: ${cmd}`));
      return true;
  }
}
// ---------- Roll flow with Luck reroll ----------
async function triggerRoll(skill){
  if(!state.rollPending){
    postDock("system","No roll requested right now.");
    ensureCampaignDoc().then(()=> saveTurn("system","No roll requested."));
    return;
  }

  const baseDice = diceForLevel(skill.tier);
  const diceCount = baseDice + (state.rollPending.aid || 0);

  const initial = [];
  for (let i=0;i<diceCount;i++) initial.push(d6());

  const initialAllSixes = initial.every(v => v === 6);
  const explosion = [];
  if (initialAllSixes && RULES?.all_sixes_explodes !== false) {
    let r = d6();
    while (r === 6) { explosion.push(r); r = d6(); }
    explosion.push(r);
  }

  const dc = state.rollPending.difficulty;
  const { mod, details } = computeModsForSkill(skill);

  const allDice = [...initial, ...explosion];
  const total = allDice.reduce((a,b)=>a+b, 0);
  const totalAdj = total + mod;

  const critMargin = RULES?.crit_margin ?? 10;
  const resultTier = totalAdj >= dc + critMargin ? "crit"
                    : totalAdj >= dc             ? "success"
                    :                               "fail";

  const rollObj = {
    skill: skill.name, level: skill.tier,
    dice: diceCount, dc,
    raw: allDice.slice(),
    explosionCount: explosion.length,
    total, mod, totalAdj,
    tierResult: resultTier,
    modDetails: details
  };

  const modsLabel = details.length ? ` (mods ${mod>=0?'+':''}${mod}: ${details.join(', ')})` : '';
  const rollMsg = `Rolled ${skill.name} (Lvl ${skill.tier}, ${diceCount}d6) → [${allDice.join(",")}] total ${total}${modsLabel} vs DC ${dc} → ${resultTier}`;
  postDock("roll", rollMsg);
  ensureCampaignDoc().then(()=> saveTurn("roll", rollMsg, rollObj));

  const usedDoAnything = (skill.name === "Do Anything");

  if(state.pc.luck <= 0){
    if(resultTier === "fail"){
      state.pc.xp += (RULES?.xp_on_fail ?? 1);
      const msg = `+${RULES?.xp_on_fail ?? 1} XP for the failed roll → ${state.pc.xp}`;
      postDock("system", msg);
      ensureCampaignDoc().then(()=> saveTurn("system", msg));
      renderHealth();
      renderSkills();
    } else if (resultTier === "success" && usedDoAnything){
      await maybeCreateNewSkillFromDoAnything();
    }
    if(initialAllSixes){
      postDock('system', `ALL 6s! ${skill.name} levels up!`);
      ensureCampaignDoc().then(()=> saveTurn("system", `ALL 6s! ${skill.name} levels up!`));
      await levelUpSkill(skill);
      renderHealth();
      renderSkills();
    }
    finalizeRoll(false, rollObj);
    return;
  }

  state.pendingReroll = { skillRef: skill, rollObj, diceCount, initial };
  const msg = postDock("system", "You may spend 1 Luck to reroll your lowest die, or resolve as-is.");
  ensureCampaignDoc().then(()=> saveTurn("system","Offered Luck reroll."));
  const controls = document.createElement("div");
  controls.className = "roll-controls";
  controls.innerHTML = `
    <div class="row gap-8">
      <button type="button" class="btn-soft tiny btn-reroll-lowest" data-action="reroll-lowest">
        Reroll Lowest (1 Luck)
      </button>
      <button type="button" class="btn-soft tiny btn-resolve" data-action="resolve">
        Resolve
      </button>
    </div>
  `;
  msg.appendChild(controls);

  if(initialAllSixes){
    postDock('system', `ALL 6s! ${skill.name} levels up!`);
    ensureCampaignDoc().then(()=> saveTurn("system", `ALL 6s! ${skill.name} levels up!`));
    await levelUpSkill(skill);
    renderHealth();
    renderSkills();
  }
}

function doLuckReroll(){
  const ctx = state.pendingReroll;
  if(!ctx) return;
  if(state.pc.luck < 1){ postDock("system","No Luck available."); ensureCampaignDoc().then(()=> saveTurn("system","No Luck available.")); return; }

  const { rollObj, diceCount, initial } = ctx;

  const justInitial = initial.slice(0, diceCount);
  const minVal = Math.min(...justInitial);
  const idx = justInitial.indexOf(minVal);

  const newVal = d6();
  initial[idx] = newVal;

  const hasExplosion = (rollObj.explosionCount||0) > 0;
  const updatedRaw = hasExplosion
    ? [...initial, ...rollObj.raw.slice(diceCount)]
    : [...initial];

  rollObj.raw = updatedRaw;
  rollObj.total = updatedRaw.reduce((a,b)=>a+b,0);
  const dc = rollObj.dc;
  const critMargin = RULES?.crit_margin ?? 10;
  rollObj.tierResult = (rollObj.total + (rollObj.mod||0)) >= dc + critMargin ? "crit"
                        : (rollObj.total + (rollObj.mod||0)) >= dc           ? "success"
                        :                                                       "fail";

  state.pc.luck -= 1;
  const msg = `Spent 1 Luck → rerolled lowest die ${minVal}→${newVal}. New total ${rollObj.total + (rollObj.mod||0)} → ${rollObj.tierResult}.`;
  postDock("system", msg);
  ensureCampaignDoc().then(()=> saveTurn("system", msg));
  renderHealth();

  finalizeRoll(true);
}

async function finalizeRoll(wasReroll, providedRollObj){
  rollHint.style.display = 'none';
  state.rollPending = null;

  const ctx = state.pendingReroll;
  const payload = providedRollObj || (ctx ? ctx.rollObj : null);

  if(ctx && ctx.rollObj && ctx.rollObj.tierResult === "fail"){
    state.pc.xp += (RULES?.xp_on_fail ?? 1);
    const msg = `+${RULES?.xp_on_fail ?? 1} XP for the failed roll → ${state.pc.xp}`;
    postDock("system", msg);
    ensureCampaignDoc().then(()=> saveTurn("system", msg));
    renderHealth();
    renderSkills();
  }

  if (ctx && ctx.skillRef && ctx.skillRef.name === "Do Anything" && ctx.rollObj.tierResult === "success") {
    await maybeCreateNewSkillFromDoAnything();
  }

  if(state.testRolling){
    postDock("system","(Test mode) Roll complete — no narration.");
    ensureCampaignDoc().then(()=> saveTurn("system","(Test mode) Roll complete."));
    state.pendingReroll = null;
    return;
  }

  if(payload){
    const recent = await getRecentTurnsForAI(8);
    aiTurnHandler({
      player_input: wasReroll ? "Resolve the action (after luck reroll)." : "Resolve the action.",
      mechanics: { roll_result: payload },
      recent_turns: recent,
      story_summary: state.storySummary || ""
    });
  }
  state.pendingReroll = null;
}

// Delegated handler for dynamic roll buttons (use classes)
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".btn-reroll-lowest, .btn-resolve");
  if (!btn) return;

  // prevent accidental double-fires
  if (btn.dataset.busy === "1") return;
  btn.dataset.busy = "1";

  try {
    if (btn.matches(".btn-reroll-lowest")) {
      doLuckReroll();
    } else if (btn.matches(".btn-resolve")) {
      finalizeRoll(false);
    }
  } catch (err) {
    console.error("resolve/reroll error:", err);
    alert("That didn’t go through. Please try again.");
  } finally {
    btn.dataset.busy = "0";
  }
}, { passive: true });

// ---------- Loot helpers (proposal workflow) ----------
// Merge item into state inventory safely
function addItemToState({ name, qty = 1, matches = [] }) { // ✨ NEW
  name = String(name || "").trim().slice(0, 64);
  qty = Math.max(1, Math.min(3, Number(qty) || 1));
  const traits = sanitizeTraitList(matches, 2); // validates against trait pool
  if (!name) return false;

  const existing = state.inv.find(it => it.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    existing.qty = Math.max(1, existing.qty + qty);
    existing.matches = sanitizeTraitList([...(existing.matches || []), ...traits], 2);
  } else {
    state.inv.push({ name, qty, matches: traits });
  }
  return true;
}

// Show Accept/Decline UI in the dock
function showLootPrompt(proposal) { // ✨ NEW
  const adds = Array.isArray(proposal?.add) ? proposal.add.slice(0,3) : [];
  if (!adds.length) return;

  state.pendingLoot = adds;

  const lines = adds.map(it => {
    const qty = Math.max(1, Number(it.qty) || 1);
    const tags = (Array.isArray(it.matches) ? it.matches.slice(0,2) : []).join(", ");
    const why  = it.why ? ` — ${escapeHtml(String(it.why))}` : "";
    return `• ${escapeHtml(String(it.name||""))} ×${qty}${tags ? ` [${escapeHtml(tags)}]` : ""}${why}`;
  }).join("<br>");

  const msg = postDock("system", "Loot proposed:");
  const box = document.createElement("div");
  box.className = "loot-proposal";
  box.style.margin = "8px 0";
  box.innerHTML = `
    <div class="loot-list" style="margin:6px 0 10px">${lines}</div>
    <div class="row gap-8">
      <button type="button" class="btn-soft tiny btn-loot-accept">Accept Loot</button>
      <button type="button" class="btn-soft tiny btn-loot-decline">Decline</button>
    </div>
  `;
  msg.appendChild(box);
}

// Delegated Accept/Decline handlers
document.addEventListener("click", async (e) => { // ✨ NEW
  const accept = e.target.closest(".btn-loot-accept");
  const decline = e.target.closest(".btn-loot-decline");
  if (!accept && !decline) return;

  if (accept) {
    const items = Array.isArray(state.pendingLoot) ? state.pendingLoot : [];
    let changed = false;
    for (const it of items) changed = addItemToState(it) || changed;
    state.pendingLoot = null;

    if (changed) {
      renderInv();
      await savePcSnapshot();
      postDock("system", "Loot accepted. Inventory updated.");
      ensureCampaignDoc().then(()=> saveTurn("system", "Loot accepted (inventory updated)."));
    } else {
      postDock("system", "Nothing to add.");
    }
  } else if (decline) {
    state.pendingLoot = null;
    postDock("system", "Loot declined.");
    ensureCampaignDoc().then(()=> saveTurn("system", "Loot declined."));
  }
}, { passive: true });

// ---------- AI turn handler ----------
async function aiTurnHandler(payload){
  try{
    const text = USE_AI ? await callAiTurn({
      ...payload,
      state_summary: buildStateSummary(),
      campaign_card: buildCampaignCard(),
      recent_turns: payload.recent_turns ?? [],
      story_summary: payload.story_summary ?? ""
    }) : null;

    if(!text){
      postDock('system', 'AI unavailable.');
      ensureCampaignDoc().then(()=> saveTurn("system","AI unavailable."));
      return;
    }

    const [firstLine, ...rest] = text.split(/\r?\n/);

    // Parse once, keep the whole object
    let firstObj = null;
    let ooc = null;
    try {
      firstObj = JSON.parse(firstLine);
      ooc = firstObj?.ooc || {};
    } catch(e){
      postDock('system','(AI format error)');
      ensureCampaignDoc().then(()=> saveTurn("system","AI format error."));
      return;
    }

    // ----- Loot proposals (NO auto-adding) -----
    const invProposal =
      ooc?.inventory_proposal ||
      ooc?.inventoryProposal ||
      firstObj?.inventory_proposal ||
      firstObj?.inventoryProposal;
    if (invProposal) {
      showLootPrompt(invProposal);
    }
    // -------------------------------------------

    if(ooc.need_roll){
      state.rollPending = { skill:ooc.skill, difficulty:ooc.difficulty, aid:0 };
      rollHint.style.display='inline-block';
      const dieTier = diceForLevel(
        (state.pc.skills.find(s=>s.name.toLowerCase()===String(ooc.skill||"").toLowerCase())?.tier) || 1
      );
      const oocLine = `Roll ${ooc.skill} ${dieTier}d6 vs ${ooc.difficulty}` + (ooc.note?` — ${ooc.note}`:'');
      postDock('dm', oocLine);
      ensureCampaignDoc().then(()=> saveTurn("ooc", oocLine, { ooc }));
    } else {
      const oocLine = ooc.prompt || '…';
      postDock('dm', oocLine);
      ensureCampaignDoc().then(()=> saveTurn("ooc", oocLine, { ooc }));
    }

    const restJoined = rest.join('\n');
    const narrative = restJoined.replace(/^[\s\r\n]*NARRATIVE:\s*/,'').trim();
    if(narrative){
      appendToBook(narrative);
      ensureCampaignDoc().then(()=> saveTurn("dm", narrative));
    }
  }catch(err){
    console.error(err);
    postDock('system', 'AI request failed.');
    ensureCampaignDoc().then(()=> saveTurn("system","AI request failed."));
  }
}

// ---------- URL + hydration ----------
function getQueryParam(name){
  const v = new URLSearchParams(location.search).get(name);
  return v ? decodeURIComponent(v) : null;
}

// replace-not-merge hydration
async function hydrateFromFirestoreByCid(){
  const cid = getQueryParam("cid");
  if(!cid){ postDock("system","No campaign id in URL."); return false; }

  try{
    const snap = await getDoc(doc(db, "campaigns", cid));
    if(!snap.exists()){ postDock("system","Campaign not found."); return false; }
    const data = snap.data();

    state.campaign = {
      id: cid,
      title: data.title || data.name || "",
      theme: data.theme || "",
      setting: data.setting || "",
      premise: data.premise || data.storyPremise || ""
    };
    state.storySummary = String(data.storySummary || "");

    const pc = (data && typeof data.pc === "object") ? data.pc : {};
    const invFromDoc = Array.isArray(data.inv) ? data.inv
                     : (Array.isArray(pc.inv) ? pc.inv : []);
    state.inv = invFromDoc.map(it => ({
      name: String(it.name || ""),
      qty: Number(it.qty || 1),
      matches: Array.isArray(it.matches) ? it.matches.slice(0,2).map(t=>String(t).toLowerCase()) : []
    }));

    const skills = Array.isArray(pc.skills) ? pc.skills.map(s => (
      typeof s === "string"
      ? { name: String(s), tier: 1, traits: [] }
      : { name: String(s.name || ""), tier: Math.max(1, Math.min(4, Number(s.tier || 1))), traits: sanitizeTraitList(s.traits, 2) }
    )) : [];

    state.pc = {
      name: String(pc.name || ""),
      description: String(pc.description || ""),
      background: String(pc.background || ""),
      portraitDataUrl: String(pc.portraitDataUrl || ""),
      xp: Number(pc.xp || 0),
      luck: Number(pc.luck || 0),
      wounds: Number(pc.wounds || 0),
      statuses: Array.isArray(pc.statuses) ? pc.statuses.map(s=>String(s)) : [],
      traits: pc.traits || null,
      skills
    };

    ensureDoAnything();

    renderSkills(); renderInv(); renderHealth();

    console.group("Hydrate campaign");
    console.log("DocID:", cid);
    console.log("Raw data:", data);
    console.log("PC (after parse):", state.pc);
    console.log("Inventory (after parse):", state.inv);
    console.groupEnd();

    return true;
  }catch(e){
    console.error(e);
    postDock("system","Error loading campaign.");
    return false;
  }
}

// ---------- Chat input ----------
const input = document.getElementById("userInput");
document.getElementById("sendBtn").onclick = async ()=>{
  const v = input.value.trim(); if(!v) return;

  // Commands
  if(handleCommand(v)){ input.value=''; return; }

  // User message
  postDock('you', v);
  ensureCampaignDoc().then(()=> saveTurn("you", v));
  input.value='';

  if(state.rollPending){
    postDock('system','A roll is pending. Tap a Skill name in the tray to roll.');
    ensureCampaignDoc().then(()=> saveTurn("system",'Roll is pending.'));
    return;
  }

  if(state.testRolling){
    postDock('system','(Test mode) Message received.');
    ensureCampaignDoc().then(()=> saveTurn("system","(Test mode) Message received."));
    return;
  }

  const recent = await getRecentTurnsForAI(8);
  aiTurnHandler({
    recent_turns: recent,
    story_summary: state.storySummary || "",
    mechanics: {
      rules: {
        dice_by_level: RULES?.dice_by_level || {1:2,2:3,3:4,4:5},
        crit_margin: RULES?.crit_margin ?? 10,
        difficulty_scale: RULES?.difficulty_scale || []
      }
    },
    player_input: v + "\n\n(Use only the provided campaign_card and state_summary.)"
  });
};
input.addEventListener('keydown', (e)=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); document.getElementById('sendBtn').click(); } });

// ---------- Starter Kit (strict; no fallbacks) ----------
async function maybeGenerateStarterKit(){
  ensureDoAnything();

  const nonDA = (state.pc.skills || []).filter(s => s.name.toLowerCase() !== "do anything");
  const needSkills = nonDA.length < 3;
  const needItems  = (state.inv || []).length < 3;
  if (!needSkills && !needItems) return false;

  const card = buildCampaignCard();
  const allowedListCsv = TRAIT_POOL.join(", ");

  const prompt = [
    "Return STRICT JSON only. No OOC, no code fences, no narrative.",
    "",
    "Create EXACTLY 3 starter skills and EXACTLY 3 starter items for the PC below.",
    "Constraints:",
    "- traits must be selected ONLY from this allowed list:",
    allowedListCsv,
    "- skills: { name: string, level: 1, traits: array of 1–2 entries from the allowed list }",
    "- items:  { name: string, qty: positive integer, matches: array of 1–2 entries from the allowed list }",
    "- names should be concise and fiction-friendly (no colons).",
    "- items should correlate to the skills' traits where sensible.",
    "",
    'Response schema (no extra fields): {"skills":[{"name":"","level":1,"traits":[""]},{"name":"","level":1,"traits":[""]},{"name":"","level":1,"traits":[""]}],"items":[{"name":"","qty":1,"matches":[""]},{"name":"","qty":1,"matches":[""]},{"name":"","qty":1,"matches":[""]}]}',
    "",
    "campaign_card:",
    JSON.stringify(card)
  ].join("\n");

  let text;
  try {
    text = await callAiTurn({
      kickoff: false,
      state_summary: buildStateSummary(),
      campaign_card: card,
      player_input: prompt
    });
  } catch (e) {
    console.warn("Starter kit AI call failed:", e);
    postDock("system", "Starter kit AI call failed; nothing generated.");
    ensureCampaignDoc().then(()=> saveTurn("system", "Starter kit AI call failed; nothing generated."));
    return false;
  }

  const jsonStr = extractFirstJsonObject(text);
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    console.warn("Starter kit JSON parse failed:", text);
    postDock("system", "Starter kit parse failed; nothing generated.");
    ensureCampaignDoc().then(()=> saveTurn("system", "Starter kit parse failed; nothing generated."));
    return false;
  }

  const skillsIn = Array.isArray(parsed.skills) ? parsed.skills.slice(0,3) : [];
  const itemsIn  = Array.isArray(parsed.items)  ? parsed.items.slice(0,3)  : [];
  if (skillsIn.length !== 3 || itemsIn.length !== 3) {
    postDock("system", "Starter kit invalid; expected 3 skills and 3 items; nothing generated.");
    ensureCampaignDoc().then(()=> saveTurn("system", "Starter kit invalid; nothing generated."));
    return false;
  }

  // Strict validation: traits MUST be from allowed pool (case-insensitive), 1–2 each
  function allTraitsValid(arr){
    if (!Array.isArray(arr) || arr.length < 1 || arr.length > 2) return false;
    return arr.every(t => isAllowedTrait(t));
  }

  // Validate + sanitize to lowercase storage
  for (const s of skillsIn) {
    if (!s || !s.name || !allTraitsValid(s.traits)) {
      postDock("system", "Starter kit invalid; traits must be chosen from allowed list.");
      ensureCampaignDoc().then(()=> saveTurn("system", "Starter kit invalid traits; nothing generated."));
      return false;
    }
  }
  for (const it of itemsIn) {
    if (!it || !it.name || !Number(it.qty) || !allTraitsValid(it.matches)) {
      postDock("system", "Starter kit invalid; item matches must be from allowed list.");
      ensureCampaignDoc().then(()=> saveTurn("system", "Starter kit invalid matches; nothing generated."));
      return false;
    }
  }

  const skills = skillsIn.map(s => ({
    name: String(s.name || "").slice(0,64),
    tier: 1,
    traits: sanitizeTraitList(s.traits, 2) // lowercase, filtered
  }));
  const items  = itemsIn.map(it => ({
    name: String(it.name || "").slice(0,64),
    qty: Math.max(1, Number(it.qty || 1)),
    matches: sanitizeTraitList(it.matches, 2) // lowercase, filtered
  }));

  if (needSkills) {
    state.pc.skills = [
      ...state.pc.skills.filter(s => s.name.toLowerCase() === "do anything"),
      ...skills
    ];
  }
  if (needItems) {
    state.inv = items;
  }

  renderSkills();
  renderInv();
  await savePcSnapshot();

  postDock("system", "Starter kit created: 3 skills + 3 items.");
  ensureCampaignDoc().then(()=> saveTurn("system", "Starter kit created: 3 skills + 3 items."));
  return true;
}

// ---------- Auth + Boot ----------
async function ensureSignedIn() {
  return new Promise((resolve, reject) => {
    onAuthStateChanged(auth, async (user) => {
      if (user) { resolve(user); }
      else {
        try {
          const cred = await signInAnonymously(auth);
          resolve(cred.user);
        } catch (e) { reject(e); }
      }
    });
  });
}

window.addEventListener('load', async ()=>{
  // cute tray peek
  setTimeout(()=>{ document.getElementById('tray').classList.add('open');
    setTimeout(()=>document.getElementById('tray').classList.remove('open'), 1200);
  }, 400);

  // 0) Load rules
  await loadRules();

  // 1) Auth
  try { await ensureSignedIn(); }
  catch (e) { postDock("system","Login failed or cancelled."); return; }

  // 2) Hydrate by ?cid=...
  const ok = await hydrateFromFirestoreByCid();

  // 2.5) One-time starter kit if missing
  await maybeGenerateStarterKit();

  // 2.7) Load saved turns (replay) and skip kickoff if history exists
  await ensureCampaignDoc();
  const turnCount = await loadTurnsAndRender();

  // 3) Luck baseline
  const startLuck = RULES?.luck?.start ?? 1;
  if (typeof state.pc.luck !== 'number' || state.pc.luck < startLuck) {
    state.pc.luck = startLuck;
    renderHealth();
  }

  // 4) Test mode guard
  if(state.testRolling){
    postDock('system','(Test mode) Ready. Use *togglerolling* to exit test mode.');
    return;
  }
  // 5) AI kickoff ONLY if no prior turns (fresh campaign)
  if (turnCount === 0) {
    aiTurnHandler({
      kickoff: true,
      recent_turns: await getRecentTurnsForAI(8),
      story_summary: state.storySummary || "",
      mechanics: {
        rules: {
          dice_by_level: RULES?.dice_by_level || {1:2,2:3,3:4,4:5},
          crit_margin: RULES?.crit_margin ?? 10,
          difficulty_scale: RULES?.difficulty_scale || []
        }
      },
      player_input: ok ? 'Use the campaign_card below and begin the adventure in THIS setting.'
                       : 'Begin a quick start one-shot using the campaign_card below.'
    });
  } else {
    postDock("system", `Loaded ${turnCount} prior turns from campaign history.`);
  }
});
