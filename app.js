// app.js — Mini Anki Class Edition (no progress bar)
// Student login (Mand####), daily limits, flip animation, SM-2-ish review flow

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js';
import {
  getFirestore, collection, doc, addDoc, getDoc, getDocs, setDoc, updateDoc,
  query, where, orderBy, limit, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js';

// ---- Your Firebase Config (as provided) ----
const firebaseConfig = {
  apiKey: "AIzaSyC4NvDxQaDhurYH38sJ_REHj8agjl185zA",
  authDomain: "mand12-f3515.firebaseapp.com",
  projectId: "mand12-f3515",
  storageBucket: "mand12-f3515.firebasestorage.app",
  messagingSenderId: "142720341393",
  appId: "1:142720341393:web:fd8ffdc26052fdc049b630",
  measurementId: "G-LWD3M5CLDY"
};
// -------------------------------------------
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ---- Basic utilities ----
const el = id => document.getElementById(id);
const show = (id, v=true) => { const x = el(id); if (x) x.style.display = v ? '' : 'none'; };
const todayKey = () => new Date().toISOString().slice(0,10);
const nowMs = () => Date.now();
const shuffle = arr => { for (let i=arr.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]] } return arr; };

function setStatus(msg){ el('status').textContent = msg || ''; }
function setQuotaStatus(){
  const d = state.daily;
  const newLeft = Math.max(0, 20 - d.newUsed);
  const revLeft = Math.max(0, 50 - d.reviewUsed);
  el('quotaStatus').textContent = `New left: ${newLeft} · Reviews left: ${revLeft} · Done: ${d.interactions}/100`;
}

// ---- App state ----
const state = {
  code: localStorage.getItem('code') || null,
  user: null,
  selectedDeck: 'ALL', // HSK2 | HSK3 | ALL | FULL
  mode: 'A',           // A or B (UI text only here)
  queue: [],
  current: null,
  daily: { date: null, newUsed: 0, reviewUsed: 0, interactions: 0 }
};

// ---- Firestore refs ----
function accountRef(){ return doc(db,'accounts',state.code); }
function cardsCol(){ return collection(db,'accounts',state.code,'cards'); }

// ---- Auth helpers ----
async function ensureSignedIn(){ if(!auth.currentUser) await signInAnonymously(auth); return auth.currentUser; }
function codeIsValid(code){ return /^Mand\d{4}$/i.test(code.trim()); }

// ---- Login/logout ----
async function login(){
  const code = el('codeInput').value.trim();
  if(!codeIsValid(code)){ alert('Please enter a code like "Mand0001".'); return; }
  try{
    await ensureSignedIn();
    const snap = await getDoc(doc(db,'codes',code));
    if(!snap.exists()){ alert('Code not found'); return; }

    await setDoc(accountRef(),{
      lastLoginAt: serverTimestamp(),
      daily: { date: todayKey(), newUsed: 0, reviewUsed: 0, interactions: 0 }
    },{ merge:true });

    state.code = code; localStorage.setItem('code', code);
    el('whoCode').textContent = code;

    show('login',false);
    show('whoami',true);
    show('studyControls',true);
    show('study',true);

    await loadDaily();
  }catch(e){
    console.error('[login] failed:', e);
    alert('Login failed (check Anonymous sign-in, Authorized domain, and Firestore rules).');
  }
}
function logout(){ localStorage.removeItem('code'); state.code=null; location.reload(); }

// ---- Daily counters ----
async function loadDaily(){
  const snap = await getDoc(accountRef());
  const dkey = todayKey();
  if(snap.exists() && snap.data().daily && snap.data().daily.date === dkey){
    state.daily = snap.data().daily;
  } else {
    state.daily = { date: dkey, newUsed: 0, reviewUsed: 0, interactions: 0 };
    await updateDoc(accountRef(),{ daily: state.daily }).catch(()=>setDoc(accountRef(),{ daily: state.daily },{ merge:true }));
  }
  setQuotaStatus();
}

// ---- Deck filter (simple client-side) ----
function deckMatches(card) {
  const sel = state.selectedDeck;
  if (sel === 'ALL' || sel === 'FULL') return true;
  return (card.deck || 'HSK2') === sel;
}

// ---- Study session ----
async function startSession(){
  if(!state.code) return;
  await loadDaily();
  state.queue = []; state.current = null;
  show('showBtn', false);
  setStatus('Loading due cards…');

  try{
    // Reviews due (limit client-side)
    const revSnap = await getDocs(query(
      cardsCol(),
      where('due','<=', nowMs()),
      orderBy('due','asc'),
      limit(400)
    ));
    let reviewCards = revSnap.docs.map(d=>({id:d.id, ...d.data()})).filter(deckMatches);

    // New cards
    const newSnap = await getDocs(query(
      cardsCol(),
      where('reps','==', 0),
      orderBy('createdAt','asc'),
      limit(400)
    ));
    let newCards = newSnap.docs.map(d=>({id:d.id, ...d.data()})).filter(deckMatches);

    // Respect daily caps
    const revLeft = Math.max(0, 50 - state.daily.reviewUsed);
    const newLeft = Math.max(0, 20 - state.daily.newUsed);
    reviewCards = reviewCards.slice(0, revLeft);
    newCards = newCards.slice(0, newLeft);

    state.queue = shuffle([...reviewCards, ...newCards]);

    if(state.queue.length===0){
      setStatus('No cards due right now.');
      return;
    }
    state.current = state.queue[0];
    renderCard(state.current.front, state.current.back);
    show('showBtn', true);
    setStatus(`Due: ${state.queue.length} card(s)`);
  }catch(e){
    console.error(e);
    setStatus('Failed to load session.');
  }
}

function renderCard(f,b){ el('cardFront').textContent=f||''; el('cardBack').textContent=b||''; }
function showAnswer(){ el('flipInner').classList.add('flipped'); show('buttons',true); show('showBtn',false); }

// ---- SM-2-ish grading ----
async function grade(q){
  const c = state.current;
  if(!c) return;

  // Compute next schedule
  let ef = c.ef || 2.5;
  let reps = c.reps || 0;
  let interval = c.interval || 0;

  if(q < 3){
    reps = 0;
    interval = 1;
  }else{
    reps++;
    if(reps === 1) interval = 1;
    else if(reps === 2) interval = 6;
    else interval = Math.max(1, Math.round(interval * ef));
  }
  ef = Math.max(1.3, ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  const due = nowMs() + interval * 86400000;

  try{
    await updateDoc(doc(db,'accounts',state.code,'cards',c.id),{
      ef, reps, interval, due, updatedAt: serverTimestamp()
    });

    // Update daily counters
    state.daily.interactions++;
    if((c.reps || 0) === 0) state.daily.newUsed++; else state.daily.reviewUsed++;
    await updateDoc(accountRef(),{ daily: state.daily });
    setQuotaStatus();

    // Next card
    state.queue.shift();
    if(state.queue.length === 0){
      await startSession();
      return;
    }
    state.current = state.queue[0];
    el('flipInner').classList.remove('flipped');
    show('buttons', false);
    renderCard(state.current.front, state.current.back);
    show('showBtn', true);
  }catch(e){
    console.error(e);
    alert('Failed to save review.');
  }
}

// ---- Wire events ----
el('loginBtn')   ?.addEventListener('click', login);
el('logoutBtn')  ?.addEventListener('click', logout);
el('startBtn')   ?.addEventListener('click', startSession);
el('showBtn')    ?.addEventListener('click', showAnswer);
el('btnAgain')   ?.addEventListener('click', ()=>grade(1));
el('btnHard')    ?.addEventListener('click', ()=>grade(3));
el('btnGood')    ?.addEventListener('click', ()=>grade(4));
el('btnEasy')    ?.addEventListener('click', ()=>grade(5));

el('deckSelect') ?.addEventListener('change', (e)=>{ state.selectedDeck = e.target.value; });
el('modeSelect') ?.addEventListener('change', (e)=>{ state.mode = e.target.value; /* caps text only */ });

onAuthStateChanged(auth,(user)=>{
  state.user=user||null;
  if(state.code && user){
    el('whoCode').textContent = state.code;
    show('login',false);
    show('whoami',true);
    show('studyControls',true);
    show('study',true);
    loadDaily();
    renderCard('Click "Start Session" to begin.', '');
  }
});

// Helpful global error log (optional)
window.addEventListener('error', (e) => {
  console.error('[App error]', e?.message || e);
});
