// app.js — Mini Anki Class Edition
// Features: Student login (Mand####), Teacher login (WynR29), Shared decks (HSK2, HSK3),
// Daily limits (20 new + 50 review), Anki-style learning steps, Shuffle, Progress bar, Resume session

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js';
import {
  getFirestore, collection, doc, addDoc, getDoc, getDocs, setDoc, updateDoc,
  query, where, orderBy, limit, serverTimestamp, getCountFromServer
} from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js';

// ---- Your Firebase Config ----
const firebaseConfig = {
  apiKey: "AIzaSyC4NvDxQaDhurYH38sJ_REHj8agjl185zA",
  authDomain: "mand12-f3515.firebaseapp.com",
  projectId: "mand12-f3515",
  storageBucket: "mand12-f3515.firebasestorage.app",
  messagingSenderId: "142720341393",
  appId: "1:142720341393:web:fd8ffdc26052fdc049b630",
  measurementId: "G-LWD3M5CLDY"
};
// --------------------------------
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ---- State ----
const state = {
  code: localStorage.getItem('code') || null,
  user: null,
  selectedDeck: 'ALL',
  mode: 'A',
  queue: [],
  seenToday: [],
  current: null,
  caps: { newCap: 20, reviewCap: 50, targetInteractions: 100 },
  daily: { date: null, newUsed: 0, reviewUsed: 0, interactions: 0 }
};

// ---- Helpers ----
const el = id => document.getElementById(id);
const show = (id, v=true) => { const x = el(id); if (x) x.style.display = v ? '' : 'none'; };
const todayKey = () => new Date().toISOString().slice(0,10);
const nowMs = () => Date.now();
const shuffle = arr => { for (let i=arr.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]] } return arr; };

function setStatus(msg){ el('status').textContent = msg || ''; }
function setQuotaStatus(){
  const d = state.daily;
  el('quotaStatus').textContent = `New left: ${20 - d.newUsed} · Reviews left: ${50 - d.reviewUsed} · Done: ${d.interactions}/100`;
}
function updateProgressBar() {
  const bar = el('progressBar');
  if (!bar) return;
  // Mode A target is 100 interactions
  const pct = Math.min(100, Math.round((state.daily.interactions / state.caps.targetInteractions) * 100));
  bar.style.width = pct + '%';
}

// ---- Firestore refs ----
function accountRef(){ return doc(db,'accounts',state.code); }
function cardsCol(){ return collection(db,'accounts',state.code,'cards'); }
function summariesRef(){ return doc(db,'summaries',state.code); }

// ---- Auth ----
async function ensureSignedIn(){ if(!auth.currentUser) await signInAnonymously(auth); return auth.currentUser; }
function codeIsValid(code){ return /^Mand\d{4}$/i.test(code.trim()); }

// ---- Login ----
async function login(){
  const code = el('codeInput').value.trim();
  if(!codeIsValid(code)){ alert('Invalid code'); return; }
  await ensureSignedIn();
  const snap = await getDoc(doc(db,'codes',code));
  if(!snap.exists()){ alert('Code not found'); return; }
  await setDoc(accountRef(),{ lastLoginAt: serverTimestamp(), daily:{date:todayKey(),newUsed:0,reviewUsed:0,interactions:0}}, {merge:true});
  state.code = code; localStorage.setItem('code',code);
  el('whoCode').textContent = code;
  show('login',false); show('whoami',true); show('studyControls',true); show('study',true);
  await loadDaily();
}
function logout(){ localStorage.removeItem('code'); state.code=null; location.reload(); }

// ---- Daily ----
async function loadDaily(){
  const snap = await getDoc(accountRef());
  const dkey = todayKey();
  if(snap.exists() && snap.data().daily && snap.data().daily.date===dkey){
    state.daily = snap.data().daily;
  } else {
    state.daily = {date:dkey,newUsed:0,reviewUsed:0,interactions:0};
    await updateDoc(accountRef(),{daily:state.daily});
  }
  setQuotaStatus(); updateProgressBar();
}

// ---- Study ----
async function startSession(){
  await loadDaily();
  const qRev = query(cardsCol(), where('due','<=',nowMs()), orderBy('due','asc'), limit(200));
  const revSnap = await getDocs(qRev);
  const reviewCards = revSnap.docs.map(d=>({id:d.id,...d.data()})).slice(0,50 - state.daily.reviewUsed);
  const qNew = query(cardsCol(), where('reps','==',0), orderBy('createdAt','asc'), limit(200));
  const newSnap = await getDocs(qNew);
  const newCards = newSnap.docs.map(d=>({id:d.id,...d.data()})).slice(0,20 - state.daily.newUsed);
  state.queue = shuffle([...reviewCards,...newCards]);
  if(state.queue.length===0){ setStatus('No cards due'); return; }
  state.current = state.queue[0];
  renderCard(state.current.front,state.current.back);
  show('showBtn',true);
}
function renderCard(f,b){ el('cardFront').textContent=f; el('cardBack').textContent=b; }
function showAnswer(){ el('flipInner').classList.add('flipped'); show('buttons',true); show('showBtn',false); }

async function grade(q){
  const c = state.current;
  let ef = c.ef||2.5, reps=c.reps||0, interval=c.interval||0;
  if(q<3){ reps=0; interval=1; } else { reps++; interval = reps===1?1:reps===2?6:Math.round(interval*ef); }
  ef = Math.max(1.3, ef+(0.1-(5-q)*(0.08+(5-q)*0.02)));
  const due = nowMs()+interval*86400000;
  await updateDoc(doc(db,'accounts',state.code,'cards',c.id),{ef,reps,interval,due,updatedAt:serverTimestamp()});
  state.daily.interactions++; if(c.reps===0) state.daily.newUsed++; else state.daily.reviewUsed++;
  await updateDoc(accountRef(),{daily:state.daily});
  setQuotaStatus(); updateProgressBar();
  state.queue.shift();
  if(state.queue