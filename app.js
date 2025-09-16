// app.js (module)

// ---- Firebase (CDN modular SDK) ----
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js';
import {
  getFirestore, collection, doc, addDoc, getDoc, getDocs, setDoc, updateDoc,
  query, where, orderBy, limit, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js';

// TODO: paste your Firebase config here
const firebaseConfig = {
  apiKey: "YOUR-API-KEY",
  authDomain: "YOUR-PROJECT.firebaseapp.com",
  projectId: "YOUR-PROJECT-ID",
  appId: "YOUR-APP-ID",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ---- State ----
const state = {
  code: localStorage.getItem('code') || null,
  user: null,
  queue: [],
  current: null
};

// ---- UI helpers ----
const el = id => document.getElementById(id);
const show = (id, v=true) => { el(id).style.display = v ? '' : 'none'; };

function setStatus(msg) { el('status').textContent = msg || ''; }
function setAddStatus(msg) { el('addStatus').textContent = msg || ''; }
function setLoginStatus(msg) { el('loginStatus').textContent = msg || ''; }

function renderCard(front = '', back = '') {
  el('cardFront').textContent = front;
  el('cardBack').textContent = back;
}
function resetFlip() {
  el('flipInner').classList.remove('flipped');
  show('buttons', false);
  show('showBtn', false);
}

// ---- Auth / Login with code ----
function codeIsValid(code) {
  return /^Mand\d{4}$/i.test(code.trim());
}

async function ensureSignedIn() {
  if (!auth.currentUser) await signInAnonymously(auth);
  return auth.currentUser;
}

async function login() {
  const code = el('codeInput').value.trim();
  setLoginStatus('');
  if (!codeIsValid(code)) {
    setLoginStatus('Please enter a code like "Mand0001".');
    return;
  }

  try {
    await ensureSignedIn();
    // Check code exists in whitelist
    const codeSnap = await getDoc(doc(db, 'codes', code));
    if (!codeSnap.exists()) {
      setLoginStatus('Code not found. Ask your teacher to enable it.');
      return;
    }

    // Create/merge account doc
    await setDoc(doc(db, 'accounts', code), {
      lastLoginAt: serverTimestamp()
    }, { merge: true });

    state.code = code;
    localStorage.setItem('code', code);

    // Switch UI
    el('whoCode').textContent = code;
    show('login', false);
    show('whoami', true);
    show('add-card', true);
    show('study', true);
    show('manage', true);

    renderCard('Click "Start Study" to begin.', '');
    setStatus('');
    setAddStatus('');
  } catch (e) {
    console.error(e);
    setLoginStatus('Login failed. Check your network and try again.');
  }
}

function logout() {
  localStorage.removeItem('code');
  state.code = null;
  state.queue = [];
  state.current = null;

  show('login', true);
  show('whoami', false);
  show('add-card', false);
  show('study', false);
  show('manage', false);
  setLoginStatus('');
  renderCard('', '');
}

// ---- Firestore helpers ----
function cardsCol() {
  if (!state.code) throw new Error('Not logged in');
  return collection(db, 'accounts', state.code, 'cards');
}

// ---- Add / Import / Export ----
async function addCard() {
  const front = el('front').value.trim();
  const back  = el('back').value.trim();
  if (!front || !back) {
    setAddStatus('Please fill both Front and Back.');
    return;
  }
  try {
    await addDoc(cardsCol(), {
      front, back,
      ef: 2.5,
      reps: 0,
      interval: 0,
      due: Date.now(),           // due immediately
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    el('front').value = '';
    el('back').value = '';
    setAddStatus('Card added.');
  } catch (e) {
    console.error(e);
    setAddStatus('Failed to add card.');
  }
}

async function exportCards() {
  try {
    const snap = await getDocs(cardsCol());
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${state.code}-cards.json`; a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error(e);
    alert('Export failed.');
  }
}

async function importCardsFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error('Invalid format');
    let count = 0;
    for (const c of data) {
      if (!c.front || !c.back) continue;
      await addDoc(cardsCol(), {
        front: String(c.front),
        back:  String(c.back),
        ef:    typeof c.ef === 'number' ? c.ef : 2.5,
        reps:  typeof c.reps === 'number' ? c.reps : 0,
        interval: typeof c.interval === 'number' ? c.interval : 0,
        due:   typeof c.due === 'number' ? c.due : Date.now(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      count++;
    }
    alert(`Imported ${count} card(s).`);
  } catch (err) {
    console.error(err);
    alert('Import failed. Make sure it is a JSON exported from this app.');
  } finally {
    e.target.value = ''; // reset file input
  }
}

// ---- Study (load queue, flip, grade) ----
async function startStudy() {
  if (!state.code) return;
  resetFlip();
  el('showBtn').style.display = 'none';
  setStatus('Loading due cards…');

  try {
    const q = query(
      cardsCol(),
      where('due', '<=', Date.now()),
      orderBy('due', 'asc'),
      limit(50)
    );
    const snap = await getDocs(q);
    state.queue = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (state.queue.length === 0) {
      renderCard('No cards due right now.', '');
      setStatus('Tip: Add cards, or check back later.');
      show('buttons', false);
      return;
    }
    state.current = state.queue[0];
    renderCard(state.current.front, state.current.back);
    setStatus(`Due: ${state.queue.length} card(s)`);
    show('showBtn', true);
  } catch (e) {
    console.error(e);
    setStatus('Failed to load due cards.');
  }
}

function showAnswer() {
  if (!state.current) return;
  el('flipInner').classList.add('flipped');
  show('buttons', true);
  show('showBtn', false);
}

// ---- SM-2 update ----
function sm2Update(card, q) {
  let ef = card.ef ?? 2.5;
  let reps = card.reps ?? 0;
  let interval = card.interval ?? 0;

  const delta = 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02);
  ef = Math.max(1.3, ef + delta);

  if (q < 3) {
    reps = 0;
    interval = 1;
  } else {
    reps += 1;
    if (reps === 1) interval = 1;
    else if (reps === 2) interval = 6;
    else interval = Math.max(1, Math.round(interval * ef));
  }

  const due = Date.now() + interval * 24 * 60 * 60 * 1000;
  return { ef, reps, interval, due };
}

async function grade(q) {
  if (!state.current) return;
  try {
    const updates = sm2Update(state.current, q);
    await updateDoc(doc(db, 'accounts', state.code, 'cards', state.current.id), {
      ...updates,
      updatedAt: serverTimestamp()
    });
    alert(`Next review in ${updates.interval} day(s).`);
  } catch (e) {
    console.error(e);
    alert('Failed to save review.');
  } finally {
    state.current = null;
    resetFlip();
    startStudy();
  }
}

// ---- Wire up events ----
onAuthStateChanged(auth, (user) => {
  state.user = user || null;

  // If we already have a code in localStorage, show the app shell
  if (state.code && user) {
    el('whoCode').textContent = state.code;
    show('login', false);
    show('whoami', true);
    show('add-card', true);
    show('study', true);
    show('manage', true);
    renderCard('Click "Start Study" to begin.', '');
  }
});

el('loginBtn').addEventListener('click', login);
el('logoutBtn').addEventListener('click', logout);
el('addBtn').addEventListener('click', addCard);
el('refreshBtn').addEventListener('click', startStudy);
el('startBtn').addEventListener('click', startStudy);
el('showBtn').addEventListener('click', showAnswer);
el('btnAgain').addEventListener('click', () => grade(1));
el('btnHard').addEventListener('click',  () => grade(3));
el('btnGood').addEventListener('click',  () => grade(4));
el('btnEasy').addEventListener('click',  () => grade(5));
el('exportBtn').addEventListener('click', exportCards);
el('importFile').addEventListener('change', importCardsFile);

// Initial UI
if (!state.code) {
  show('login', true);
  show('whoami', false);
  show('add-card', false);
  show('study', false);
  show('manage', false);
} else {
  // try auto-login flow: sign in anonymously so rules allow reads
  ensureSignedIn().catch(() => {});
}
