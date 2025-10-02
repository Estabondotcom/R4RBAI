// ---------- Minimal client state ----------
const state = {
  campaignId: crypto.randomUUID(),
  pc: {
    name: "Rin Kestrel",
    // Wounds are how many empty hearts you have. Max hearts = 4.
    wounds: 0,              // 0..4  (0 = all hearts full, 4 = all empty)
    luck: 0,                // numeric
    xp: 0,                  // numeric
    statuses: [],
    portraitDataUrl: "",    // optional (if you pass from campaign)
    skills: [
      { name: "Athletics", tier: 3 },
      { name: "Streetwise", tier: 4 },
      { name: "Improvisation", tier: 2 }
    ]
  },
  inv: [
    { name: "Glider cloak", qty: 1 },
    { name: "Lockpicks", qty: 1 },
    { name: "Rations", qty: 2 }
  ],
  rollPending: null,
  testRolling: false
};

// ---------- DOM refs ----------
const bookEl = document.getElementById("book");
const dockEl = document.getElementById("dockMessages");
const rollHint = document.getElementById("rollHint");
const scrollLock = document.getElementById("scrollLock");

// ---------- Right tray wiring ----------
const tray = document.getElementById("tray");
document.getElementById("trayToggle").onclick = () =>
  tray.classList.toggle("open");

document.getElementById("tabs").onclick = (e) => {
  if (e.target.tagName !== "BUTTON") return;
  [...document.querySelectorAll(".tabs button")].forEach((b) =>
    b.classList.remove("active")
  );
  e.target.classList.add("active");
  const map = { skills: "panel-skills", inv: "panel-inv", health: "panel-health" };
  Object.values(map).forEach(
    (id) => (document.getElementById(id).style.display = "none")
  );
  document.getElementById(map[e.target.dataset.tab]).style.display = "block";
};

function renderSkills() {
  const wrap = document.getElementById("panel-skills");
  wrap.innerHTML = "";
  state.pc.skills.forEach((s) => {
    const row = document.createElement("div");
    row.className = "skill";
    row.innerHTML = `<span class="name">${s.name}</span>
      <span class="pill">${s.tier}d6</span>
      <button data-skill='${s.name}'>Roll</button>`;
    row.querySelector("button").onclick = () => triggerRoll(s);
    wrap.appendChild(row);
  });
}
function renderInv() {
  document.getElementById("invList").innerHTML = state.inv
    .map((i) => `• ${i.name} ×${i.qty}`)
    .join("<br/>");
}

// ---- New: Health panel UI (mobile-friendly)
// Hearts: always 4, start full (♥). Each wound makes one heart empty (♡).
// Luck: numeric. XP: numeric. Buy Luck: -2 XP, +1 Luck.
const HEARTS_MAX = 4;

function renderHealth() {
  const panel = document.getElementById("panel-health");
  panel.innerHTML = `
    <div class="charCard">
      <div class="portraitBox">
        ${
          state.pc.portraitDataUrl
            ? `<img class="portrait" src="${state.pc.portraitDataUrl}" alt="Portrait">`
            : `<div class="portrait placeholder">Portrait</div>`
        }
      </div>

      <div class="rows">
        <div class="nameRow">
          <h3 class="pcName">${escapeHtml(state.pc.name || "—")}</h3>
        </div>

        <div class="row">
          <span class="label">Wounds</span>
          <span id="woundsRow" class="icons"></span>
        </div>

        <div class="row">
          <span class="label">XP</span>
          <span class="value" id="xpVal">${state.pc.xp}</span>
        </div>

        <div class="row">
          <span class="label">Luck</span>
          <span class="value" id="luckVal">${state.pc.luck}</span>
        </div>

        <div class="row">
          <button id="buyLuckBtn" class="btn-soft tiny">Buy 1 Luck (2 XP)</button>
        </div>

        <div class="row">
          <span class="label">Statuses</span>
          <span id="statuses" class="value">${state.pc.statuses.join(", ") || "—"}</span>
        </div>
      </div>
    </div>
  `;

  // Hearts render (♥ full first, then empty ♡). Wounds = empty hearts.
  const W = document.getElementById("woundsRow");
  W.innerHTML = "";
  const heartsFilled = Math.max(0, HEARTS_MAX - state.pc.wounds);
  for (let i = 0; i < HEARTS_MAX; i++) {
    const h = document.createElement("span");
    h.className = "pill heart";
    h.textContent = i < heartsFilled ? "♥" : "♡";
    W.appendChild(h);
  }

  // Buy luck handler
  document.getElementById("buyLuckBtn").onclick = () => {
    if (state.pc.xp < 2) {
      postDock("system", "Not enough XP to buy Luck (need 2 XP).");
      return;
    }
    state.pc.xp -= 2;
    state.pc.luck += 1;
    postDock("system", "Spent 2 XP → +1 Luck.");
    renderHealth();
  };
}

renderSkills();
renderInv();
renderHealth();

// ---------- Book typing effect ----------
function appendToBook(text) {
  const paragraphs = text.trim().split(/\n{2,}/);
  let idx = 0;
  function typeNextPara() {
    if (idx >= paragraphs.length) return;
    const p = document.createElement("p");
    p.className = "fade-in";
    bookEl.appendChild(p);
    typewriter(paragraphs[idx] + "\n", p, 10, () => {
      idx++;
      if (!scrollLock.checked) {
        p.scrollIntoView({ behavior: "smooth", block: "end" });
      }
      typeNextPara();
    });
  }
  typeNextPara();
}
function typewriter(str, node, speed = 12, done) {
  let i = 0;
  (function tick() {
    node.textContent += str[i++] || "";
    if (!scrollLock.checked)
      node.parentElement.scrollTop = node.parentElement.scrollHeight;
    if (i < str.length) {
      setTimeout(tick, Math.max(6, speed));
    } else done && done();
  })();
}

// ---------- Chat Dock ----------
function postDock(role, text) {
  const div = document.createElement("div");
  div.className = "msg";
  div.innerHTML = `<span class='tag'>[${role}]</span>${escapeHtml(text)}`;
  dockEl.appendChild(div);
  dockEl.scrollTop = dockEl.scrollHeight;
}
function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// ---------- COMMANDS ----------
function handleCommand(raw) {
  // Supports *command* or *command N* (e.g. *addxp 5*)
  const m = raw.match(/^\*(\w+)(?:\s+(-?\d+))?\*$/i);
  if (!m) return false;
  const cmd = m[1].toLowerCase();
  const argN = m[2] != null ? parseInt(m[2], 10) : null;

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  switch (cmd) {
    case "addluck": {
      state.pc.luck += 1;
      renderHealth();
      postDock("system", `Luck +1 → ${state.pc.luck}`);
      return true;
    }
    case "removeluck": {
      state.pc.luck = Math.max(0, state.pc.luck - 1);
      renderHealth();
      postDock("system", `Luck -1 → ${state.pc.luck}`);
      return true;
    }
    case "addwound": {
      state.pc.wounds = clamp(state.pc.wounds + 1, 0, HEARTS_MAX);
      renderHealth();
      postDock("system", `Wound +1 → ${state.pc.wounds}/${HEARTS_MAX} (hearts now ${HEARTS_MAX - state.pc.wounds} full)`);
      return true;
    }
    case "removewound": {
      state.pc.wounds = clamp(state.pc.wounds - 1, 0, HEARTS_MAX);
      renderHealth();
      postDock("system", `Wound -1 → ${state.pc.wounds}/${HEARTS_MAX} (hearts now ${HEARTS_MAX - state.pc.wounds} full)`);
      return true;
    }
    case "addxp": {
      const n = Number.isFinite(argN) ? argN : 1;
      state.pc.xp = Math.max(0, state.pc.xp + n);
      renderHealth();
      postDock("system", `XP ${n >= 0 ? "+" : ""}${n} → ${state.pc.xp}`);
      return true;
    }
    case "togglerolling": {
      state.testRolling = !state.testRolling;
      if (state.testRolling) {
        state.rollPending = { skill: "Test", difficulty: 14 };
        rollHint.style.display = "inline-block";
        postDock(
          "system",
          "Test rolling: ON — tap any Skill’s “Roll” to test vs DC 14. (No narration in test mode.)"
        );
      } else {
        state.rollPending = null;
        rollHint.style.display = "none";
        postDock("system", "Test rolling: OFF");
      }
      return true;
    }
    default:
      postDock("system", `Unknown command: ${cmd}`);
      return true; // treat as handled to avoid sending to AI
  }
}

// ---------- Roll flow (client-authoritative for demo) ----------
function triggerRoll(s) {
  if (!state.rollPending) {
    postDock("system", "No roll requested right now.");
    return;
  }
  const dice = s.tier + (state.rollPending.aid || 0);
  let raw = [],
    explosions = 0,
    total = 0;
  function rollD6() {
    const r = Math.floor(Math.random() * 6) + 1;
    raw.push(r);
    total += r;
    if (r === 6) {
      explosions++;
      rollD6();
    }
  }
  for (let i = 0; i < dice; i++) rollD6();
  const dc = state.rollPending.difficulty;
  const tierResult =
    total >= dc + 6 ? "crit" : total >= dc ? "success" : total >= dc - 4 ? "mixed" : "fail";
  const rollObj = { skill: s.name, tier: s.tier, dc, raw, explosions, total, tierResult };

  rollHint.style.display = "none";
  state.rollPending = null;

  postDock(
    "roll",
    `Rolled ${s.name} ${s.tier}d6 → [${raw.join(",")}] total ${total} vs DC ${dc} → ${tierResult}`
  );

  if (state.testRolling) {
    postDock("system", "(Test mode) Roll complete — no narration.");
    return;
  }

  fakeAiTurn({ player_input: "Resolve the action.", mechanics: { roll_result: rollObj } });
}

// ---------- Simulated AI (replace with real API later) ----------
function fakeModelResponse(payload) {
  if (payload.kickoff) {
    return `{"ooc":{"need_roll":false,"prompt":"Sirens rise along the wharf. What do you do first?"}}

NARRATIVE:
Fog boils off the harbor as a hoist bell clangs over the canals. Emberquay’s iron ribs creak—skytracks groaning, gulls wheeling like scraps of paper. You shoulder through dockhands, cloak stitched at the edges; heights gnaw at your gut and the city ignores it. Word came at dawn: the stolen device is on foot. Two crews shadow the courier. If it reaches the Old Battery, the sky will peel open like wet parchment.

Lanterns flare across the crane yard. The rooftops beyond offer a jagged run of chimneys and wash lines. Somewhere ahead, a runner slips through steam—fast, cautious, burdened.`;
  }
  if (payload.mechanics && payload.mechanics.roll_result) {
    const r = payload.mechanics.roll_result;
    const map = {
      crit: [
        "You move like a rumor, untouchable.",
        "Opportunity blooms ahead—an open door and a dropped key."
      ],
      success: [
        "You ghost between pallets; the lookout turns too late.",
        "Distance closes; breath steadies; the runner is in reach."
      ],
      mixed: [
        "You make ground, but a bell tolls—eyes swing your way.",
        "You’ll have to choose: cover or speed."
      ],
      fail: [
        "Boots slam steel; a shout goes up; light spears the fog.",
        "The runner gains ground while you dive for cover."
      ]
    };
    const lines = map[r.tierResult];
    return `{"ooc":{"need_roll":false,"prompt":"Catwalk or lower walkway—where do you push next?"}}

NARRATIVE:
${lines[0]} Pallets blur—tar, hemp, salt. A crane groans; the world tips into the yawning canal and you ride the sway, knees soft, hands skimming rail. ${lines[1]} The harbor exhales—sirens doppler, gulls scatter—and the city asks its only question again: how badly do you want this?`;
  }
  const askRoll = Math.random() < 0.5;
  if (askRoll) {
    const s = state.pc.skills[Math.floor(Math.random() * state.pc.skills.length)];
    const dc = 12 + Math.floor(Math.random() * 7);
    return `{"ooc":{"need_roll":true,"skill":"${s.name}","dieTier":${s.tier},"difficulty":${dc},"note":"Mixed success creates a complication."}}`;
  } else {
    return `{"ooc":{"need_roll":false,"prompt":"What do you do?"}}

NARRATIVE:
Wind tugs at laundry spans as a barge thumps the pilings. Somewhere ahead, the quarry slips through steam, careful as a pickpocket’s smile.`;
  }
}

async function fakeAiTurn(payload) {
  const text = fakeModelResponse(payload);
  const [firstLine, ...rest] = text.split(/\r?\n/);
  let ooc = null;
  try {
    ooc = JSON.parse(firstLine).ooc;
  } catch (e) {
    postDock("system", "(Format error)");
    return;
  }
  if (ooc.need_roll) {
    state.rollPending = { skill: ooc.skill, difficulty: ooc.difficulty };
    rollHint.style.display = "inline-block";
    postDock(
      "dm",
      `Roll ${ooc.skill} ${ooc.dieTier}d6 vs ${ooc.difficulty}` +
        (ooc.note ? ` — ${ooc.note}` : "")
    );
  } else {
    postDock("dm", ooc.prompt || "…");
  }
  const restJoined = rest.join("\n");
  const narrative = restJoined.replace(/^[\s\r\n]*NARRATIVE:\s*/, "").trim();
  if (narrative) appendToBook(narrative);
}

// ---------- Chat input ----------
const input = document.getElementById("userInput");
document.getElementById("sendBtn").onclick = () => {
  const v = input.value.trim();
  if (!v) return;

  // Commands intercept (*cmd* or *cmd N*)
  if (handleCommand(v)) {
    input.value = "";
    return;
  }

  // Normal message
  postDock("you", v);
  input.value = "";
  if (state.rollPending) {
    postDock("system", "A roll is pending. Tap the matching skill in the tray.");
    return;
  }
  fakeAiTurn({ state_summary: {}, recent_turns: [], mechanics: {}, player_input: v });
};
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    document.getElementById("sendBtn").click();
  }
});

// ---------- Kickoff ----------
window.addEventListener("load", () => {
  setTimeout(() => {
    document.getElementById("tray").classList.add("open");
    setTimeout(() => document.getElementById("tray").classList.remove("open"), 1200);
  }, 400);
  fakeAiTurn({
    kickoff: true,
    state_summary: {},
    recent_turns: [],
    mechanics: {},
    player_input: "Begin the adventure."
  });
});
