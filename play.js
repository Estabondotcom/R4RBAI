// ---------- Minimal client state ----------
const state = {
  campaignId: crypto.randomUUID(),
  pc: {
    name: "Rin Kestrel",
    wounds: 0,              // 0..4 (0 = all hearts full, 4 = all empty)
    luck: 0,                // numeric
    xp: 0,                  // numeric
    statuses: [],
    portraitDataUrl: "",
    // NOTE: 'tier' == Level (1..4). Dice = level + 1 (L1=2d6 ... L4=5d6)
    skills: [
      { name: "Athletics", tier: 2 },
      { name: "Streetwise", tier: 3 },
      { name: "Improvisation", tier: 1 }
    ]
  },
  inv: [
    { name: "Glider cloak", qty: 1 },
    { name: "Lockpicks", qty: 1 },
    { name: "Rations", qty: 2 }
  ],
  rollPending: null,          // set by AI when a roll is requested
  testRolling: false,         // test mode flag: client-only rolls, no narration
  pendingReroll: null         // holds roll context while offering luck reroll
};

// ---------- DOM refs ----------
const bookEl = document.getElementById("book");
const dockEl = document.getElementById("dockMessages");
const rollHint = document.getElementById("rollHint");
const scrollLock = document.getElementById("scrollLock");

// ---------- AI Config ----------
const USE_AI = true;
// TODO: replace <YOUR_PROJECT_ID> after deploying functions
const AI_URL = "https://us-central1-<YOUR_PROJECT_ID>.cloudfunctions.net/aiTurn";

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
    pc: {
      name: state.pc.name,
      xp: state.pc.xp,
      luck: state.pc.luck,
      wounds: state.pc.wounds,
      statuses: state.pc.statuses,
      skills: state.pc.skills.map(s=>({ name: s.name, level: s.tier }))
    }
  };
}

// ---------- Helpers ----------
function diceForLevel(level){ return Math.max(1, Math.min(5, level + 1)); } // L1=2d6 .. L4=5d6
function xpCostToNext(level){ return level >= 4 ? 5 : (level + 1); }       // L4 uses specialization cost 5 XP

function levelUpSkill(skill){
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
    state.pc.skills.push({ name: specName, tier: 1 });
    postDock("system", `Unlocked specialization: ${specName} (Level 1).`);
  }
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
  const wrap = document.getElementById("panel-skills");
  wrap.innerHTML = "";

  state.pc.skills.forEach(s=>{
    const level = s.tier;
    const diceN = diceForLevel(level);
    const cost = xpCostToNext(level);
    const enoughXP = state.pc.xp >= cost;

    const row = document.createElement("div");
    row.className = "skill";
    row.innerHTML = `
      <button type="button" class="skillRollBtn" data-skill="${s.name}">
        ${escapeHtml(s.name)}
      </button>
      <div class="skillMeta">
        <span class="pill">Level ${level}</span>
        <span class="pill">${diceN}d6</span>
      </div>
      <div class="skillActions">
        ${level < 4
          ? `<button type="button" class="btn-soft tiny" data-levelup="${s.name}" ${enoughXP?'':'disabled'}>
               Level Up (${cost} XP)
             </button>`
          : `<button type="button" class="btn-soft tiny" data-special="${s.name}" ${enoughXP?'':'disabled'}>
               Specialize (5 XP)
             </button>`}
      </div>
    `;

    // Skill name = roll
    row.querySelector(".skillRollBtn").addEventListener("click", ()=> triggerRoll(s));

    // Level up / Specialize handlers
    if(level < 4){
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
    } else {
      const btn = row.querySelector("[data-special]");
      btn && btn.addEventListener("click", ()=>{
        if(state.pc.xp < 5){
          postDock("system", `Need 5 XP to unlock a specialization for ${s.name}. You have ${state.pc.xp}.`);
          return;
        }
        state.pc.xp -= 5;
        levelUpSkill(s);   // at L4 this creates a specialization
        renderHealth();
        renderSkills(); // keep button states in sync
      });
    }

    wrap.appendChild(row);
  });
}

function renderInv(){
  document.getElementById("invList").innerHTML = state.inv.map(i=>`• ${i.name} ×${i.qty}`).join("<br/>");
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
        <div class="row"><button type="button" id="buyLuckBtn" class="btn-soft tiny">Buy 1 Luck (2 XP)</button></div>
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
      if(state.pc.xp < 2){
        postDock("system","Not enough XP to buy Luck (need 2 XP).");
        return;
      }
      state.pc.xp -= 2;
      state.pc.luck += 1;
      postDock("system","Spent 2 XP → +1 Luck.");
      renderHealth();
      renderSkills();   // refresh buttons after XP changes
    });
  }
}

renderSkills(); renderInv(); renderHealth();

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
  div.innerHTML=`<span class='tag'>[${role}]</span>${escapeHtml(text)}`;
  dockEl.appendChild(div);
  dockEl.scrollTop=dockEl.scrollHeight;
  return div; // return element so we can attach buttons when needed
}
function escapeHtml(s){ return s.replace(/[&<>]/g,c=>({ "&":"&amp;","<":"&lt;",">":"&gt;" }[c])); }

// ---------- Commands (keep your *function* format) ----------
function handleCommand(raw){
  // Supports "*command*" or "*command N*"
  const m=raw.match(/^\*(\w+)(?:\s+(-?\d+))?\*$/i); if(!m) return false;
  const cmd=m[1].toLowerCase(); const argN=m[2]!=null?parseInt(m[2],10):null;
  const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));

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

  const baseDice = diceForLevel(skill.tier);
  const diceCount = baseDice + (state.rollPending.aid || 0);

  let raw = [], explosions = 0, total = 0;
  function rollD6(){ const r=Math.floor(Math.random()*6)+1; raw.push(r); total+=r; if(r===6){ explosions++; rollD6(); } }
  for(let i=0;i<diceCount;i++) rollD6();

  const dc = state.rollPending.difficulty;
  const resultTier = total >= dc+6 ? "crit" : total >= dc ? "success" : total >= dc-4 ? "mixed" : "fail";
  const rollObj = { skill: skill.name, level: skill.tier, dice: diceCount, dc, raw: raw.slice(), explosions, total, tierResult: resultTier };

  // determine if initial dice (excluding explosion chain) are all sixes
  const initialAllSixes = raw.slice(0, diceCount).every(v => v === 6);

  // show the roll
  postDock("roll", `Rolled ${skill.name} (Lvl ${skill.tier}, ${diceCount}d6) → [${raw.join(",")}] total ${total} vs DC ${dc} → ${resultTier}`);

  // If no luck, resolve immediately and still award XP on fail
  if(state.pc.luck <= 0){
    if(resultTier === "fail"){
      state.pc.xp += 1;
      postDock("system", `+1 XP for the failed roll → ${state.pc.xp}`);
      renderHealth();
      renderSkills(); // keep buttons in sync
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

  // Offer Luck reroll if possible (and only once)
  state.pendingReroll = {
    skillRef: skill,
    rollObj,
    diceCount,
    used: false
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
  if(!ctx || ctx.used) return;
  if(state.pc.luck < 1){ postDock("system","No Luck available."); return; }

  const { rollObj, diceCount } = ctx;

  // find the index of the lowest among the initial dice (first diceCount entries)
  const initial = rollObj.raw.slice(0, diceCount);
  let minVal = Math.min(...initial);
  let idx = initial.indexOf(minVal);

  // perform the reroll on that die
  const newVal = Math.floor(Math.random()*6)+1;
  rollObj.raw[idx] = newVal;
  // recompute total: original total minus old + new
  rollObj.total = rollObj.total - minVal + newVal;
  rollObj.tierResult = rollObj.total >= rollObj.dc+6 ? "crit" :
                       rollObj.total >= rollObj.dc    ? "success" :
                       rollObj.total >= rollObj.dc-4  ? "mixed" : "fail";

  state.pc.luck -= 1;
  ctx.used = true;
  postDock("system", `Spent 1 Luck → rerolled lowest die ${minVal}→${newVal}. New total ${rollObj.total} → ${rollObj.tierResult}.`);
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
    state.pc.xp += 1;
    postDock("system", `+1 XP for the failed roll → ${state.pc.xp}`);
    renderHealth();
    renderSkills();
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

// ---------- AI turn handler (no fake text) ----------
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
      postDock('dm', `Roll ${ooc.skill} ${ooc.dieTier}d6 vs ${ooc.difficulty}` + (ooc.note?` — ${ooc.note}`:''));
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
    recent_turns: [],
    mechanics: {},
    player_input: v
  });
};
input.addEventListener('keydown', (e)=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); document.getElementById('sendBtn').click(); } });

// ---------- Kickoff ----------
window.addEventListener('load', ()=>{
  setTimeout(()=>{ document.getElementById('tray').classList.add('open'); setTimeout(()=>document.getElementById('tray').classList.remove('open'), 1200); }, 400);

  if(state.testRolling){
    postDock('system','(Test mode) Ready. Use *togglerolling* to exit test mode.');
    return;
  }

  aiTurnHandler({
    kickoff: true,
    state_summary: buildStateSummary(),
    recent_turns: [],
    mechanics: {},
    player_input:'Begin the adventure.'
  });
});
