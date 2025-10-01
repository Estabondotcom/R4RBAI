// Firebase Login + Firestore bootstrap
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  appId: "YOUR_APP_ID",
};

import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import { getAuth, setPersistence, browserLocalPersistence, onAuthStateChanged,
         signInWithEmailAndPassword, createUserWithEmailAndPassword, signInAnonymously } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id)=>document.getElementById(id);
const statusEl = $('status'), errEl = $('err'), okEl = $('ok');

function setStatus(msg){ statusEl.textContent = msg || ''; }
function setErr(msg){ errEl.style.display = msg ? 'block' : 'none'; errEl.textContent = msg||''; }
function setOk(msg){ okEl.style.display = msg ? 'block' : 'none'; okEl.textContent = msg||''; }

async function ensureUserDoc(user){
  const ref = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);
  const base = {
    email: user.email || null,
    isAnonymous: !!user.isAnonymous,
    updatedAt: serverTimestamp(),
  };
  if (!snap.exists()){
    await setDoc(ref, { ...base, createdAt: serverTimestamp() });
  } else {
    await setDoc(ref, base, { merge: true });
  }
}

async function goPlay(){ window.location.href = "play.html"; }

async function handleSignIn(){
  setErr(''); setOk(''); setStatus('Signing in…');
  try {
    await setPersistence(auth, browserLocalPersistence);
    const email = $('email').value.trim();
    const password = $('password').value;
    const cred = await signInWithEmailAndPassword(auth, email, password);
    await ensureUserDoc(cred.user);
    setOk('Signed in! Redirecting…'); goPlay();
  } catch (e){ setErr(humanAuthError(e)); } finally { setStatus(''); }
}
async function handleSignUp(){
  setErr(''); setOk(''); setStatus('Creating account…');
  try {
    await setPersistence(auth, browserLocalPersistence);
    const email = $('email').value.trim();
    const password = $('password').value;
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await ensureUserDoc(cred.user);
    setOk('Account created! Redirecting…'); goPlay();
  } catch (e){ setErr(humanAuthError(e)); } finally { setStatus(''); }
}
async function handleGuest(){
  setErr(''); setOk(''); setStatus('Continuing as guest…');
  try {
    await setPersistence(auth, browserLocalPersistence);
    const cred = await signInAnonymously(auth);
    await ensureUserDoc(cred.user);
    setOk('Guest session active. Redirecting…'); goPlay();
  } catch (e){ setErr(humanAuthError(e)); } finally { setStatus(''); }
}

$('signinBtn').onclick = handleSignIn;
$('signupBtn').onclick = handleSignUp;
$('guestBtn').onclick = handleGuest;

onAuthStateChanged(auth, (user)=>{ if(user){ setStatus('Signed in — redirecting…'); goPlay(); } });

function humanAuthError(e){
  const code = e?.code || '';
  if(code.includes('auth/invalid-email')) return 'Invalid email address.';
  if(code.includes('auth/missing-password')) return 'Enter a password.';
  if(code.includes('auth/weak-password')) return 'Password should be at least 6 characters.';
  if(code.includes('auth/email-already-in-use')) return 'Email already in use.';
  if(code.includes('auth/invalid-credential') || code.includes('auth/wrong-password')) return 'Incorrect email or password.';
  if(code.includes('auth/network-request-failed')) return 'Network error — check your connection.';
  return e.message || 'Something went wrong.';
}
