import { firebaseConfig } from './firebaseConfigShim.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";

initializeApp(firebaseConfig);
const auth = getAuth();

onAuthStateChanged(auth, (user) => {
  if (!user) {
    const next = encodeURIComponent(location.pathname + location.search);
    location.href = `index.html?next=${next}`;
  }
});
