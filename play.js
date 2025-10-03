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
    skills: []          // ← empty; we'll add Do Anything dynamically
  },
  inv: [],              // ← empty; starter kit or Firestore will populate
  rollPending: null,
  testRolling: false,
  pendingReroll: null
};


// ---------- DOM refs ----------
const bookEl = document.getElementById("book");
const dockEl = document.getElementById("dockMessages");
const rollHint = document.getElementById("rollHint");
const scrollLock = document.getElementById("scrollLock");

// ---------- AI Config ----------
const USE_AI = true;
// Use your deployed v2 Cloud Run URL here:
const AI_URL = "https://aiturn-gyp3ryw5ga-uc.a.run.app";

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

// ---------- Helpers ----------
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
    // tiny normalization
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

function diceForLevel(level){
  // Prefer RULES if loaded; fall back to simple +1 rule (L1=2d6 .. L4=5d6)
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

  // Wounds global penalty (PDF: wounds level 2 = -3 to all checks)
  if (RULES?.wounds && state.pc.wounds >= (RULES.wounds.penalty_at_or_above ?? 2)) {
    const v = RULES.wounds.penalty_value ?? -3;
    mod += v; details.push(`wounds ${v}`);
  }

  // Status effects from state.pc.statuses (strings), mapped via RULES.statuses
  for (const s of (state.pc.statuses || [])) {
    const defs = RULES.statuses?.[String(s).toLowerCase()];
    if (!defs) continue;
    for (const [tag,val] of Object.entries(defs)) {
      if (traits.includes(tag.toLowerCase())) { mod += val; details.push(`${s} ${val}`); }
    }
  }

  // Item bonuses from state.inv, mapped via RULES.items
  for (const it of (state.inv || [])) {
    const defs = RULES.items?.[String(it.name||"").toLowerCase()];
    if (!defs) continue;
    const qty = it.qty || 1;
    for (const [tag,val] of Object.entries(defs)) {
      if (traits.includes(tag.toLowerCase())) { mod += (val * qty); details.push(`${it.name} ${val*qty}`); }
    }
  }

  return { mod, details };
}

function d6(){ return Math.floor(Math.random()*6)+1; }

function ensureDoAnything(){
  if (!state.pc.skills.some(s => s.name === "Do Anything")) {
    state.pc.skills.unshift({ name: "Do Anything", tier: 1, traits: ["improv"] });
  }
}

function levelUpSkill(skill){
  if(skill.name === "Do Anything"){ // locked
    postDock("system", `"Do Anything" cannot be leveled.`);
    return;
  }
  if(skill.tier < 4){
    skill.tier += 1;
    postDock("system", `${skill.name} leveled up to Level ${skill.tier}.`);
  } else {
    // Specialize from cap
    const base = skill.name.replace(/\s*\(Spec.*\)$/,'');
    const specName = prompt(
      `Create a specialization for "${base}" (e.g., "${base}: Rooftop Parkour")`,
      `${base}: Specialization`
    ) || `${base}: Specialization`;
    state.pc.skills.push({ name: specName, tier: 1, traits: skillTraits(skill) });
    postDock("system", `Unlocked specialization: ${specName} (Level 1).`);
  }
  renderSkills();
}

function maybeCreateNewSkillFromDoAnything(){
  const name = prompt("Success with Do Anything! Name the new related skill (Level 1):", "");
  if (!name) return;
  if (state.pc.skills.some(s => s.name.toLowerCase() === name.toLowerCase())) {
    postDock("system", `Skill "${name}" already exists.`);
    return;
  }
  const traitStr = prompt("Add 1–2 traits for this skill (comma-separated, e.g., social,cunning):", "");
  const traits = (traitStr||"")
    .split(",").map(s=>s.trim()).filter(Boolean).slice(0,2);
  state.pc.skills.push({ name, tier: 1, traits });
  postDock("system", `New skill created: ${name} (Level 1) — traits: ${traits.join(", ")||"—"}.`);
  renderSkills();
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

// ---------- Skills (name is the roll button; right side is Level Up / Specialize) ----------
function renderSkills(){
  ensureDoAnything();

  const wrap = document.getElementById("panel-skills");
  wrap.innerHTML = "";

  state.pc.skills.forEach(s=>{
    const level = s.tier;
    const diceN = diceForLevel(level);
    const cost = xpCostToNext(level);
    const enoughXP = state.pc.xp >= cost;
    const isDoAnything = s.name === "Do Anything";

    const row = document.createElement("div");
    row.className = "skill";
    row.innerHTML = `
      <button type="button" class="skillRollBtn" data-skill="${s.name}">
        ${escapeHtml(s.name)}
      </button>
      <div class="skillMeta">
        <span class="pill">Level ${level}</span>
        <span class="pill">${diceN}d6</span>
        ${
          (Array.isArray(s.traits) && s.traits.length)
            ? s.traits.map(t=>`<span class="pill soft">${escapeHtml(t)}</span>`).join("")
            : ""
        }
      </div>
      <div class="skillActions"></div>
    `;

    // Action buttons (lock Do Anything)
    const actions = row.querySelector(".skillActions");
    if(isDoAnything){
      actions.innerHTML = `<button type="button" class="btn-soft tiny" disabled title="Cannot level Do Anything">Locked</button>`;
    } else if (level < 4){
      actions.innerHTML = `<button type="button" class="btn-soft tiny" data-levelup="${s.name}" ${enoughXP?'':'disabled'}>
        Level Up (${cost} XP)
      </button>`;
    } else {
      actions.innerHTML = `<button type="button" class="btn-soft tiny" data-special="${s.name}" ${enoughXP?'':'disabled'}>
        Specialize (${xpCostToNext(level)} XP)
      </button>`;
    }

    // Skill name = roll
    row.querySelector(".skillRollBtn").addEventListener("click", ()=> triggerRoll(s));

    // Level up / Specialize handlers
    if(!isDoAnything && level < 4){
      const btn = row.querySelector("[data-levelup]");
      btn && btn.addEventListener("click", ()=>{
        const need = xpCostToNext(s.tier);
        if(state.pc.xp < need){
          postDock("system", `Need ${need} XP to level up ${s.name}. You have ${state.pc.xp}.`);
          return;
        }
        state.pc.xp -= need;
        levelUpSkill(s);
        renderHealth();
        renderSkills(); // keep button states in sync
      });
    } else if (!isDoAnything && level >= 4) {
      const btn = row.querySelector("[data-special]");
      btn && btn.addEventListener("click", ()=>{
        const need = xpCostToNext(s.tier);
        if(state.pc.xp < need){
          postDock("system", `Need ${need} XP to unlock a specialization for ${s.name}. You have ${state.pc.xp}.`);
          return;
        }
        state.pc.xp -= need;
        levelUpSkill(s);   // at L4 this creates a specialization
        renderHealth();
        renderSkills(); // keep button states in sync
      });
    }

    wrap.appendChild(row);
  });
}

function renderInv(){
  document.getElementById("invList").innerHTML = state.inv.map(i=>`• ${escapeHtml(i.name)} ×${i.qty}`).join("<br/>");
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
        return;
      }
      state.pc.xp -= cost;
      state.pc.luck += 1;
      postDock("system",`Spent ${cost} XP → +1 Luck.`);
      renderHealth();
      renderSkills();   // refresh buttons after XP changes
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
  return div; // return element so we can attach buttons when needed
}
function escapeHtml(s){ return String(s).replace(/[&<>]/g,c=>({ "&":"&amp;","<":"&lt;",">":"&gt;" }[c])); }

// ---------- Commands ----------
function handleCommand(raw){
  // Supports "*command*" or "*command N*"
  const m=raw.match(/^\*(\w+)(?:\s+(-?\d+))?\*$/i); if(!m) return false;
  const cmd=m[1].toLowerCase(); const argN=m[2]!=null?parseInt(m[2],10):null;
  const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));

  // quick status add/remove: *addstatus drunk* / *removestatus drunk*
  const mStatus = raw.match(/^\*(addstatus|removestatus)\s+(.+)\*$/i);
  if (mStatus) {
    const action = mStatus[1].toLowerCase();
    const name = mStatus[2].trim();
    if (name) {
      if (action === "addstatus") {
        if (!state.pc.statuses.includes(name)) state.pc.statuses.push(name);
        postDock("system", `Status added: ${name}`);
      } else {
        state.pc.statuses = state.pc.statuses.filter(s=>s.toLowerCase()!==name.toLowerCase());
        postDock("system", `Status removed: ${name}`);
      }
      renderHealth();
    }
    return true;
  }

  switch(cmd){
    case "addluck":
      state.pc.luck += 1; renderHealth(); postDock("system",`Luck +1 → ${state.pc.luck}`); return true;
    case "removeluck":
      state.pc.luck = Math.max(0, state.pc.luck - 1); renderHealth(); postDock("system",`Luck -1 → ${state.pc.luck}`); return true;
    case "addwound":
      state.pc.wounds = clamp(state.pc.wounds + 1, 0, HEARTS_MAX); renderHealth(); postDock("system",`Wound +1 → ${state.pc.wounds}/${HEARTS_MAX}`); return true;
    case "removewound":
      state.pc.wounds = clamp(state.pc.wounds - 1, 0, HEARTS_MAX); renderHealth(); postDock("system",`Wound -1 → ${state.pc.wounds}/${HEARTS_MAX}`); return true;
    case "addxp": {
      const n = Number.isFinite(argN) ? argN : 1;
      state.pc.xp = Math.max(0, state.pc.xp + n);
      renderHealth();
      renderSkills();   // refresh skills so Level Up buttons enable/disable properly
      postDock("system",`XP ${n>=0?"+":""}${n} → ${state.pc.xp}`);
      return true;
    }
    case "newsession":
      state.pc.luck = RULES?.luck?.start ?? 1;
      postDock("system",`New session: Luck reset to ${state.pc.luck}.`);
      renderHealth();
      return true;
    case "togglerolling":
      state.testRolling = !state.testRolling;
      if(state.testRolling){
        state.rollPending = { skill:"Test", difficulty:14, aid:0 }; // generic DC so you can roll right away
        rollHint.style.display='inline-block';
        postDock('system','Test rolling: ON — tap any Skill name to roll vs DC 14. (No narration in test mode.)');
      } else {
        state.rollPending = null;
        rollHint.style.display='none';
        postDock('system','Test rolling: OFF');
      }
      return true;
    default:
      postDock("system",`Unknown command: ${cmd}`);
      return true; // treat as handled to avoid sending to AI
  }
}

// ---------- Roll flow with Luck "reroll lowest" offer ----------
function triggerRoll(skill){
  if(!state.rollPending){
    postDock("system","No roll requested right now.");
    return;
  }

  // how many dice?
  const baseDice = diceForLevel(skill.tier);
  const diceCount = baseDice + (state.rollPending.aid || 0);

  // roll the initial pool (no explosions yet)
  const initial = [];
  for (let i=0;i<diceCount;i++) initial.push(d6());

  // all-6s explosion chain (PDF): only if initial pool is all 6s
  const initialAllSixes = initial.every(v => v === 6);
  const explosion = [];
  if (initialAllSixes && RULES?.all_sixes_explodes !== false) {
    let r = d6();
    while (r === 6) { explosion.push(r); r = d6(); }
    explosion.push(r);
  }

  const dc = state.rollPending.difficulty;

  // modifiers: wounds penalty + status/item vs skill traits
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

  // show the roll
  const modsLabel = details.length ? ` (mods ${mod>=0?'+':''}${mod}: ${details.join(', ')})` : '';
  postDock("roll", `Rolled ${skill.name} (Lvl ${skill.tier}, ${diceCount}d6) → [${allDice.join(",")}] total ${total}${modsLabel} vs DC ${dc} → ${resultTier}`);

  const usedDoAnything = (skill.name === "Do Anything");

  // If no luck, resolve immediately and still award XP on fail; Do Anything success => new skill
  if(state.pc.luck <= 0){
    if(resultTier === "fail"){
      state.pc.xp += (RULES?.xp_on_fail ?? 1);
      postDock("system", `+${RULES?.xp_on_fail ?? 1} XP for the failed roll → ${state.pc.xp}`);
      renderHealth();
      renderSkills(); // keep buttons in sync
    } else if (resultTier === "success" && usedDoAnything){
      maybeCreateNewSkillFromDoAnything();
    }
    // All-6s on initial pool → level up before narration
    if(initialAllSixes){
      postDock('system', `ALL 6s! ${skill.name} levels up!`);
      levelUpSkill(skill);
      renderHealth();
      renderSkills();
    }
    finalizeRoll(false, rollObj);
    return;
  }

  // Offer Luck reroll if possible (and only once) — reroll lowest among initial pool only
  state.pendingReroll = {
    skillRef: skill,
    rollObj,
    diceCount,
    initial // keep the original initial dice for lowest selection
  };
  const msg = postDock("system", "You may spend 1 Luck to reroll your lowest die, or resolve as-is.");
  const controls = document.createElement("div");
  controls.style.margin = "6px 0 0 28px";
  controls.innerHTML = `
    <button type="button" id="btnRerollLowest" class="btn-soft tiny">Reroll Lowest (1 Luck)</button>
    <button type="button" id="btnResolve" class="btn-soft tiny">Resolve</button>
  `;
  msg.appendChild(controls);

  document.getElementById("btnRerollLowest").addEventListener("click", ()=> doLuckReroll());
  document.getElementById("btnResolve").addEventListener("click", ()=> finalizeRoll(false));

  // All-6s on initial pool → level up before narration
  if(initialAllSixes){
    postDock('system', `ALL 6s! ${skill.name} levels up!`);
    levelUpSkill(skill);
    renderHealth();
    renderSkills();
  }
}

function doLuckReroll(){
  const ctx = state.pendingReroll;
  if(!ctx) return;
  if(state.pc.luck < 1){ postDock("system","No Luck available."); return; }

  const { rollObj, diceCount, initial } = ctx;

  // find the index of the lowest among the initial dice (first diceCount entries)
  const justInitial = initial.slice(0, diceCount);
  const minVal = Math.min(...justInitial);
  const idx = justInitial.indexOf(minVal);

  // perform the reroll on that die
  const newVal = d6();
  // We need to update both the composed raw list in rollObj and our copy of initial[]
  initial[idx] = newVal;

  // rebuild rollObj.raw from updated initial + any explosion dice that were in the original
  const hasExplosion = (rollObj.explosionCount||0) > 0;
  const updatedRaw = hasExplosion
    ? [...initial, ...rollObj.raw.slice(diceCount)]  // keep original explosion chain intact
    : [...initial];

  rollObj.raw = updatedRaw;
  rollObj.total = updatedRaw.reduce((a,b)=>a+b,0);
  const dc = rollObj.dc;
  const critMargin = RULES?.crit_margin ?? 10;
  rollObj.tierResult = (rollObj.total + (rollObj.mod||0)) >= dc + critMargin ? "crit"
                        : (rollObj.total + (rollObj.mod||0)) >= dc           ? "success"
                        :                                                       "fail";

  state.pc.luck -= 1;
  postDock("system", `Spent 1 Luck → rerolled lowest die ${minVal}→${newVal}. New total ${rollObj.total + (rollObj.mod||0)} → ${rollObj.tierResult}.`);
  renderHealth();

  finalizeRoll(true);
}

function finalizeRoll(wasReroll, providedRollObj){
  // Clear hint & pending
  rollHint.style.display = 'none';
  state.rollPending = null;

  const ctx = state.pendingReroll;
  const payload = providedRollObj || (ctx ? ctx.rollObj : null);

  // Apply XP on fail here for the reroll case (non-reroll/no-luck already handled in triggerRoll)
  if(ctx && ctx.rollObj && ctx.rollObj.tierResult === "fail"){
    state.pc.xp += (RULES?.xp_on_fail ?? 1);
    postDock("system", `+${RULES?.xp_on_fail ?? 1} XP for the failed roll → ${state.pc.xp}`);
    renderHealth();
    renderSkills();
  }

  // If we had a pending reroll context and ended with success on Do Anything, offer new skill
  if (ctx && ctx.skillRef && ctx.skillRef.name === "Do Anything" && ctx.rollObj.tierResult === "success") {
    maybeCreateNewSkillFromDoAnything();
  }

  // Test mode: stop here (no narration)
  if(state.testRolling){
    postDock("system","(Test mode) Roll complete — no narration.");
    state.pendingReroll = null;
    return;
  }

  // Send to AI
  if(payload){
    aiTurnHandler({
      player_input: wasReroll ? "Resolve the action (after luck reroll)." : "Resolve the action.",
      mechanics: { roll_result: payload }
    });
  }
  state.pendingReroll = null;
}

// ---------- AI turn handler ----------
async function aiTurnHandler(payload){
  try{
    const text = USE_AI ? await callAiTurn({
      ...payload,
      state_summary: buildStateSummary(),
      recent_turns: [] // (optional) wire up later if you log turns
    }) : null;

    if(!text){
      postDock('system', 'AI unavailable.');
      return;
    }
    const [firstLine, ...rest] = text.split(/\r?\n/);
    let ooc = null;
    try { ooc = JSON.parse(firstLine).ooc; }
    catch(e){ postDock('system','(AI format error)'); return; }

    if(ooc.need_roll){
      state.rollPending = { skill:ooc.skill, difficulty:ooc.difficulty, aid:0 };
      rollHint.style.display='inline-block';
      const dieTier = diceForLevel(
        (state.pc.skills.find(s=>s.name.toLowerCase()===String(ooc.skill||"").toLowerCase())?.tier) || 1
      );
      postDock('dm', `Roll ${ooc.skill} ${dieTier}d6 vs ${ooc.difficulty}` + (ooc.note?` — ${ooc.note}`:''));
    } else {
      postDock('dm', ooc.prompt || '…');
    }
    const restJoined = rest.join('\n');
    const narrative = restJoined.replace(/^[\s\r\n]*NARRATIVE:\s*/,'').trim();
    if(narrative) appendToBook(narrative);
  }catch(err){
    console.error(err);
    postDock('system', 'AI request failed.');
  }
}

// ---------- URL + Firebase: hydrate campaign/pc by ?cid= ----------
function getQueryParam(name){
  const v = new URLSearchParams(location.search).get(name);
  return v ? decodeURIComponent(v) : null;
}

// Firebase (read-only on this page)
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously   // quick dev login (swap for Google/email later)
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

// If your app is already initialized elsewhere on this page, this will be a no-op
const fbApp = getApps().length ? getApps()[0] : initializeApp({
  apiKey: "AIzaSyCV8U5deVGvGBHn00DtnX6xkkNZJ2895Qo",
  authDomain: "r4rbai.firebaseapp.com",
  projectId: "r4rbai"
});
const db = getFirestore(fbApp);
const auth = getAuth(fbApp); // <-- IMPORTANT: bind Auth to the same app


async function hydrateFromFirestoreByCid(){
  const cid = getQueryParam("cid");
  if(!cid){ postDock("system","No campaign id in URL."); return false; }

  try{
    const snap = await getDoc(doc(db, "campaigns", cid));
    if(!snap.exists()){ postDock("system","Campaign not found."); return false; }
    const data = snap.data();

    // Campaign meta
    state.campaign = {
      id: cid,
      title: data.title || data.name || "",
      theme: data.theme || "",
      setting: data.setting || "",
      premise: data.premise || data.storyPremise || ""
    };

    // Inventory (optional)
    if(Array.isArray(data.inv)) state.inv = data.inv;

    // PC
    const pc = data.pc || {};
    state.pc = {
      ...state.pc,
      name: pc.name || "",
      description: pc.description || "",
      background: pc.background || "",
      portraitDataUrl: pc.portraitDataUrl || "",
      xp: Number(pc.xp || 0),
      luck: Number(pc.luck || 0),
      wounds: Number(pc.wounds || 0),
      statuses: Array.isArray(pc.statuses) ? pc.statuses : [],
      traits: pc.traits || null,
      skills: Array.isArray(pc.skills) && pc.skills.length
        ? pc.skills.map(s=>({ name:String(s.name||""), tier:Number(s.tier||1), traits: Array.isArray(s.traits)? s.traits.slice(0,2) : [] }))
        : state.pc.skills
    };

    // Ensure Do Anything is present post-hydration
    ensureDoAnything();

    // Re-render UI with real data
    renderSkills(); renderInv(); renderHealth();
    return true;
  }catch(e){
    console.error(e);
    postDock("system","Error loading campaign.");
    return false;
  }
}

// ---------- Chat input ----------
const input = document.getElementById("userInput");
document.getElementById("sendBtn").onclick = ()=>{
  const v = input.value.trim(); if(!v) return;

  // Commands intercept (*cmd* or *cmd N*)
  if(handleCommand(v)){ input.value=''; return; }

  // Normal message
  postDock('you', v);
  input.value='';
  if(state.rollPending){
    postDock('system','A roll is pending. Tap a Skill name in the tray to roll.');
    return;
  }

  if(state.testRolling){
    // No AI in test mode; just acknowledge.
    postDock('system','(Test mode) Message received.');
    return;
  }

aiTurnHandler({
  state_summary: buildStateSummary(),
  campaign_card: buildCampaignCard(),
  recent_turns: [],
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
async function maybeGenerateStarterKit(){
  const nonDA = (state.pc.skills || []).filter(s => s.name.toLowerCase() !== "do anything");
  const needSkills = nonDA.length < 3;
  const needItems  = (state.inv || []).length < 3;
  if (!needSkills && !needItems) return false;

  const card = buildCampaignCard();
  const prompt = [
    "Create EXACTLY 3 starter skills and 3 starter items for this PC.",
    "- Skills: name, level=1, 1–2 traits.",
    "- Items: name, qty, matches=1–2 traits that support skills.",
    "- Return strict JSON only. Schema:",
    '{ "skills":[{ "name":"", "level":1, "traits":[""] }], "items":[{ "name":"", "qty":1, "matches":[""] }] }',
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
  } catch (e) { console.warn("Starter kit AI call failed:", e); return false; }

  let jsonStr = text.trim();
  if (!jsonStr.startsWith("{")) {
    const first = jsonStr.indexOf("{");
    const last = jsonStr.lastIndexOf("}");
    if (first >= 0 && last > first) jsonStr = jsonStr.slice(first, last+1);
  }
  let parsed;
  try { parsed = JSON.parse(jsonStr); }
  catch(e){ postDock("system","Starter kit parse failed."); return false; }

  const skills = (parsed.skills||[]).slice(0,3).map(s=>({
    name:String(s.name||""),
    tier:1,
    traits:Array.isArray(s.traits)?s.traits.slice(0,2).map(t=>String(t).toLowerCase()):[]
  }));
  const items = (parsed.items||[]).slice(0,3).map(it=>({
    name:String(it.name||""),
    qty:Math.max(1,Number(it.qty||1))
  }));

  if(needSkills) {
    state.pc.skills = [ ...state.pc.skills.filter(s=>s.name.toLowerCase()==="do anything"), ...skills ];
  }
  if(needItems) { state.inv = items; }

  renderSkills(); renderInv();
  postDock("system","Starter kit created: 3 skills + 3 items.");
  return true;
}

// ---------- Kickoff ----------
async function ensureSignedIn() {
  return new Promise((resolve, reject) => {
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        resolve(user); // ✅ already logged in
      } else {
        try {
          // Quick fix: anonymous login
          const cred = await signInAnonymously(auth);
          resolve(cred.user);
        } catch (e) {
          reject(e);
        }
      }
    });
  });
}

window.addEventListener('load', async ()=>{
  // cute tray peek
  setTimeout(()=>{ document.getElementById('tray').classList.add('open');
    setTimeout(()=>document.getElementById('tray').classList.remove('open'), 1200);
  }, 400);

  // 0) Load rules FIRST so UI labels & AI cheat-sheet are correct
  await loadRules();

  // 1) Ensure we are signed in before touching Firestore
  try {
    await ensureSignedIn();
  } catch (e) {
    postDock("system","Login failed or cancelled.");
    return;
  }

  // 2) Load campaign by ?cid=...
  const ok = await hydrateFromFirestoreByCid();

  // 2.5) Create starter kit if missing (3 L1 skills + 3 items, once)
  await maybeGenerateStarterKit();

  // 3) Session start: ensure Luck = start value if not set/persisted higher
  const startLuck = RULES?.luck?.start ?? 1;
  if (typeof state.pc.luck !== 'number' || state.pc.luck < startLuck) {
    state.pc.luck = startLuck;
    renderHealth();
  }

  // 4) If test mode, don't call AI
  if(state.testRolling){
    postDock('system','(Test mode) Ready. Use *togglerolling* to exit test mode.');
    return;
  }

  // 5) Start AI with hydrated data, pass a compact campaign card so the AI sticks to your world
  aiTurnHandler({
    kickoff: true,
    state_summary: buildStateSummary(),
    campaign_card: buildCampaignCard(),
    recent_turns: [],
    mechanics: {
      rules: {
        dice_by_level: RULES?.dice_by_level || {1:2,2:3,3:4,4:5},
        crit_margin: RULES?.crit_margin ?? 10,
        difficulty_scale: RULES?.difficulty_scale || []
      }
    },
    player_input: ok ? 'Use the campaign_card below and begin the adventure in THIS setting.' 
                     : 'Begin a quick start one-shot using the campaign_card below.',
  });
});
