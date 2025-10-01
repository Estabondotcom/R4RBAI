// Campaign list + creation (Firestore, per-user)
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";
import { getFirestore, collection, addDoc, query, where, orderBy, getDocs, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";

import { firebaseConfig } from './firebaseConfigShim.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id)=>document.getElementById(id);
const listEl = $('campaignList');

function card(html){
  const div = document.createElement('div');
  div.className = 'card';
  div.innerHTML = html;
  return div;
}

async function loadCampaigns(uid){
  listEl.innerHTML = '<div class="empty">Loading campaigns…</div>';
  const q = query(collection(db, 'campaigns'), where('uid','==',uid), orderBy('updatedAt','desc'));
  const snap = await getDocs(q);
  listEl.innerHTML = '';
  if (snap.empty){
    listEl.appendChild(card('<div class="empty">No campaigns yet. Create one below!</div>'));
    return;
  }
  snap.forEach(docSnap=>{
    const c = docSnap.data();
    const id = docSnap.id;
    const meta = `<span class="badge">${c.theme || '—'}</span> <span class="badge">${c.setting || '—'}</span>`;
    const html = `
      <h3>${c.name || 'Untitled Campaign'}</h3>
      <div class="tiny muted">${meta}</div>
      <p class="muted" style="margin-top:6px">${(c.premise||'').slice(0,160)}</p>
      <div class="row">
        <button data-open="${id}">Open</button>
        <a class="tiny" href="#" data-copy="${id}">Copy id</a>
      </div>`;
    const el = card(html);
    el.querySelector('[data-open]').onclick = ()=> {
      location.href = `play.html?cid=${encodeURIComponent(id)}`;
    };
    el.querySelector('[data-copy]').onclick = (e)=>{
      e.preventDefault();
      navigator.clipboard?.writeText(id);
      alert('Campaign ID copied.');
    };
    listEl.appendChild(el);
  });
}

async function createCampaign(uid){
  const name = $('c_name').value.trim();
  const theme = $('c_theme').value.trim();
  const setting = $('c_setting').value.trim();
  const charname = $('c_charname').value.trim();
  const premise = $('c_premise').value.trim();
  const chardesc = $('c_chardesc').value.trim();

  const ref = await addDoc(collection(db, 'campaigns'), {
    uid, name, theme, setting, charname, premise, chardesc,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  location.href = `play.html?cid=${encodeURIComponent(ref.id)}`;
}

$('createBtn').onclick = async ()=>{
  const user = auth.currentUser;
  if(!user) return alert('Not signed in.');
  try{ await createCampaign(user.uid); } catch(e){ alert('Create failed: ' + (e.message||e)); }
};
$('signOutBtn').onclick = ()=> signOut(auth);

onAuthStateChanged(auth, (user)=>{
  if(!user) return;
  loadCampaigns(user.uid).catch(e=>{
    listEl.innerHTML = '<div class="empty">Failed to load campaigns.</div>';
    console.error(e);
  });
});
