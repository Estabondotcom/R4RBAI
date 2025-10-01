// Minimal auth guard for play.html
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyCV8U5deVGvGBHn00DtnX6xkkNZJ2895Qo",
  authDomain: "r4rbai.firebaseapp.com",
  projectId: "r4rbai",
  storageBucket: "r4rbai.firebasestorage.app",
  messagingSenderId: "289173907451",
  appId: "1:289173907451:web:86afa1cc2b0610bf56cd5e",
  measurementId: "G-G0MSMZ3C9X"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

onAuthStateChanged(auth, (user)=>{
  if(!user){ window.location.href = "login.html"; }
  else { window.currentUser = user; }
});
