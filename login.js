import { firebaseConfig } from './firebaseConfigShim.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import { getAuth, setPersistence, browserLocalPersistence, onAuthStateChanged,
         signInWithEmailAndPassword, createUserWithEmailAndPassword, signInAnonymously } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id)=>document.getElementById(id);
const statusEl = $('status'), errEl = $('err'), okEl = $('ok');

const params = new URLSearchParams(location.search);
const nextUrl = params.get('next');

function setStatus(msg){ statusEl.textContent = msg || ''; }
function setErr(msg){ errEl.style.display = msg ? 'block' : 'none'; errEl.textContent = msg||''; }
function setOk(msg){ okEl.style.display = msg ? 'block' : 'none'; okEl.textContent = msg||''; }

async function ensureUserDoc(user){
  const ref = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);
  const base = { email: user.email || null, isAnonymous: !!user.isAnonymous, updatedAt: serverTimestamp() };
  if (!snap.exists()) await setDoc(ref, { ...base, createdAt: serverTimestamp() });
  else await setDoc(ref, base, { merge: true });
}

function goNext(){
  const defaultDest = 'campaigns.html';
  location.href = nextUrl ? decodeURIComponent(nextUrl) : defaultDest;
}

async function handleSignIn(){
  setErr(''); setOk(''); setStatus('Signing in…');
  try {
    await setPersistence(auth, browserLocalPersistence);
    const email = $('email').value.trim();
    const password = $('password').value;
    const cred = await signInWithEmailAndPassword(auth, email, password);
    await ensureUserDoc(cred.user);
    setOk('Signed in! Redirecting…'); goNext();
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
    setOk('Account created! Redirecting…'); goNext();
  } catch (e){ setErr(humanAuthError(e)); } finally { setStatus(''); }
}


$('signinBtn').onclick = handleSignIn;
$('signupBtn').onclick = handleSignUp;

onAuthStateChanged(auth, (user)=>{ if (user) goNext(); });

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
