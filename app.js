// app.js (module) — Mini Anki (Class) with daily limits, learning steps, decks, shared decks

// ---- Firebase (CDN modular SDK) ----
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-app.js';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-auth.js';
import {
  getFirestore, collection, doc, addDoc, getDoc, getDocs, setDoc, updateDoc,
  query, where, orderBy, limit, serverTimestamp, getCountFromServer
} from 'https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js';

// TODO: paste your Firebase config
const firebaseConfig = {
  apiKey: "YOUR-API-KEY",
  authDomain: "YOUR-PROJECT.firebaseapp.com",
  projectId: "YOUR-PROJECT-ID",
  appId: "YOUR-APP-ID",
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ---- State & helpers ----
const el = id => document.getElementById(id);
const show = (id, v=true) => { el(id).style.display = v ? '' : 'none'; };
const todayKey = () => new Date().toISOString().slice(0,10); // YYYY-MM-DD
const shuffle = arr => { for (let i=arr.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [arr[i],arr[j]]=[arr[j],arr[i]];} return arr; };

const state = {
  code: localStorage.getItem('code') || null,   // student code
  user: null,
  // study session
  selectedDeck: 'ALL',      // HSK2 | HSK3 | ALL | FULL
  mode: 'A',                // A | B
  queue: [],                // cards due right now
  learningQueue: [],        // in-session learning items (due timestamps)
  seenToday: [],            // card ids seen today
  current: null,
  // quotas
  caps: { newCap: 20, reviewCap: 50, targetInteractions: 100 }, // Mode A defaults
  daily: { date: null, newUsed: 0, reviewUsed: 0, interactions: 0 },
  teacherActive: false
};

function setStatus(msg) { el('status').textContent = msg || ''; }
function setAddStatus(msg) { el('addStatus').textContent = msg || ''; }
function setLoginStatus(msg) { el('loginStatus').textContent = msg || ''; }
function setTeacherLoginStatus(msg) { el('teacherLoginStatus').textContent = msg || ''; }
function setQuotaStatus() {
  const d = state.daily;
  const { newCap, reviewCap, targetInteractions } = state.caps;
  el('quotaStatus').textContent =
    `New left: ${Math.max(0,newCap - d.newUsed)}  ·  Reviews left: ${Math.max(0,reviewCap - d.reviewUsed)}  ·  Interactions: ${d.interactions}/${targetInteractions}`;
}
function renderCard(front = '', back = '') {
  el('cardFront').textContent = front;
  el('cardBack').textContent = back;
}
function resetFlip() {
  el('flipInner').classList.remove('flipped');
  show('buttons', false);
  show('showBtn', false);
}
function deckMatches(card) {
  if (state.selectedDeck === 'ALL' || state.selectedDeck === 'FULL') return true;
  return (card.deck || 'HSK2') === state.selectedDeck;
}
function nowMs() { return Date.now(); }

// ---- Firestore refs ----
function accountRef() { return doc(db, 'accounts', state.code); }
function cardsCol()   { return collection(db, 'accounts', state.code, 'cards'); }
function summariesRef() { return doc(db, 'summaries', state.code); }
function sharedDeckCol(deckId) { return collection(db, 'sharedDecks', deckId, 'cards'); }

// ---- Auth helpers ----
async function ensureSignedIn() {
  if (!auth.currentUser) await signInAnonymously(auth);
  return auth.currentUser;
}

// ---- Code format ----
function codeIsValid(code) { return /^Mand\d{4}$/i.test(code.trim()); }

// ---- Login/Logout (Student) ----
async function login() {
  const code = el('codeInput').value.trim();
  setLoginStatus('');
  if (!codeIsValid(code)) { setLoginStatus('Please enter a code like "Mand0001".'); return; }

  try {
    await ensureSignedIn();
    const codeSnap = await getDoc(doc(db, 'codes', code));
    if (!codeSnap.exists()) { setLoginStatus('Code not found.'); return; }

    // seed/merge account doc with daily counters
    const dkey = todayKey();
    await setDoc(accountRef(), {
      lastLoginAt: serverTimestamp(),
      daily: { date: dkey, newUsed: 0, reviewUsed: 0, interactions: 0 },
      syncedDecks: {}   // track deck syncs here
    }, { merge: true });

    state.code = code;
    localStorage.setItem('code', code);
    el('whoCode').textContent = code;

    // show UI
    show('login', false);
    show('whoami', true);
    show('studyControls', true);
    show('add-card', true);
    show('study', true);
    show('manage', true);
    renderCard('Click "Start Session" to begin.', '');

    // load daily counters and auto-sync class decks (HSK2 & HSK3) if not yet
    await loadDaily();
    await autoSyncSharedDecks();
    setQuotaStatus();
  } catch (e) {
    console.error(e);
    setLoginStatus('Login failed. Check your network and try again.');
  }
}
function logout() {
  localStorage.removeItem('code');
  state.code = null;
  state.queue = []; state.learningQueue = []; state.seenToday = []; state.current = null;
  show('login', true);
  show('whoami', false);
  show('studyControls', false);
  show('add-card', false);
  show('study', false);
  show('manage', false);
  setLoginStatus('');
  renderCard('', '');
}

// ---- Daily counters & caps ----
async function loadDaily() {
  const snap = await getDoc(accountRef());
  if (snap.exists()) {
    const acc = snap.data();
    const dkey = todayKey();
    if (!acc.daily || acc.daily.date !== dkey) {
      // reset day
      await updateDoc(accountRef(), { daily: { date: dkey, newUsed: 0, reviewUsed: 0, interactions: 0 } });
      state.daily = { date: dkey, newUsed: 0, reviewUsed: 0, interactions: 0 };
    } else {
      state.daily = acc.daily;
    }
  } else {
    const dkey = todayKey();
    state.daily = { date: dkey, newUsed: 0, reviewUsed: 0, interactions: 0 };
  }
  setCapsFromMode();
}
function setCapsFromMode() {
  // Mode A: 20 new + 50 review + practice fill to 100
  // Mode B: 20 new + 30 seen (or 50 seen if no new)
  const mode = state.mode;
  if (mode === 'A') {
    state.caps = { newCap: 20, reviewCap: 50, targetInteractions: 100 };
  } else {
    state.caps = { newCap: 20, reviewCap: 30, targetInteractions: 50 }; // targetInteractions unused in B
  }
}

// ---- Add / Import / Export (student personal cards) ----
async function addCard() {
  const front = el('front').value.trim();
  const back  = el('back').value.trim();
  const deck  = el('addDeck').value;
  if (!front || !back) { setAddStatus('Please fill both Front and Back.'); return; }
  try {
    await addDoc(cardsCol(), {
      front, back, deck,
      ef: 2.5, reps: 0, interval: 0,
      due: nowMs(),
      learning: false, learningStep: 0, learningDue: null,
      suspended: false, flagged: false,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
    el('front').value = ''; el('back').value = '';
    setAddStatus('Card added.');
    await updateSummaryCounts();
  } catch (e) { console.error(e); setAddStatus('Failed to add card.'); }
}
async function exportCards() {
  try {
    const snap = await getDocs(cardsCol());
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${state.code}-cards.json`; a.click();
    URL.revokeObjectURL(url);
  } catch (e) { console.error(e); alert('Export failed.'); }
}
async function importCardsFile(e) {
  const file = e.target.files[0]; if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error('Invalid JSON array');
    let count = 0;
    for (const c of data) {
      if (!c.front || !c.back) continue;
      await addDoc(cardsCol(), {
        front: String(c.front), back: String(c.back),
        deck: c.deck || 'HSK2',
        ef: typeof c.ef==='number'? c.ef : 2.5,
        reps: typeof c.reps==='number'? c.reps : 0,
        interval: typeof c.interval==='number'? c.interval : 0,
        due: typeof c.due==='number'? c.due : nowMs(),
        learning: !!c.learning, learningStep: c.learningStep||0, learningDue: c.learningDue||null,
        suspended: !!c.suspended, flagged: !!c.flagged,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      });
      count++;
    }
    alert(`Imported ${count} card(s).`);
    await updateSummaryCounts();
  } catch (err) { console.error(err); alert('Import failed. Ensure JSON array of {front,back,deck?...}.'); }
  finally { e.target.value = ''; }
}

// ---- Build session queue (respect daily caps + deck + shuffle) ----
async function startSession() {
  if (!state.code) return;
  await loadDaily();
  resetFlip();
  setCapsFromMode();
  setQuotaStatus();
  state.queue = []; state.learningQueue = []; state.seenToday = []; state.current = null;
  el('showBtn').style.display = 'none';
  setStatus('Loading due cards…');

  try {
    // 1) Learning due now (within-session / prior steps)
    const learningQ = query(
      cardsCol(),
      where('learning', '==', true),
      where('learningDue', '<=', nowMs()),
      orderBy('learningDue', 'asc'),
      limit(200)
    );
    const learningSnap = await getDocs(learningQ);
    state.learningQueue = learningSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(deckMatches);

    // 2) Review due now (not learning)
    const reviewLimit = Math.max(0, state.caps.reviewCap - state.daily.reviewUsed);
    let reviewBatch = [];
    if (reviewLimit > 0) {
      const qRev = query(
        cardsCol(),
        where('reps', '>', 0),
        where('due', '<=', nowMs()),
        orderBy('due', 'asc'),
        limit(200)
      );
      const revSnap = await getDocs(qRev);
      reviewBatch = revSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => !c.learning && deckMatches(c));
    }

    // 3) New cards (reps==0, not suspended)
    const newLimit = Math.max(0, state.caps.newCap - state.daily.newUsed);
    let newBatch = [];
    if (newLimit > 0) {
      const qNew = query(cardsCol(), where('reps', '==', 0), orderBy('createdAt', 'asc'), limit(300));
      const newSnap = await getDocs(qNew);
      newBatch = newSnap.docs.map(d => ({ id: d.id, ...d.data() }))
                  .filter(c => !c.suspended && deckMatches(c));
    }

    // Trim to daily caps
    reviewBatch = reviewBatch.slice(0, reviewLimit);
    newBatch = newBatch.slice(0, newLimit);

    // Merge: learning first (time-sensitive), then review, then new
    let queue = [...state.learningQueue, ...reviewBatch, ...newBatch];

    // Shuffle (but keep learning first)
    const learnedHead = state.learningQueue.length;
    const head = queue.slice(0, learnedHead);
    const tail = shuffle(queue.slice(learnedHead));
    state.queue = [...head, ...tail];

    if (state.queue.length === 0) {
      // practice fill if Mode A and interactions < target
      if (state.mode === 'A' && state.daily.interactions < state.caps.targetInteractions && state.seenToday.length > 0) {
        state.queue = shuffle([...state.seenToday.map(id => ({ id, practiceOnly: true }))]);
        setStatus('Practice fill (does not change schedule)…');
      } else {
        renderCard('No cards due right now.', '');
        setStatus('Tip: Add cards, change deck, or check later.');
        show('buttons', false);
        return;
      }
    }

    state.current = state.queue[0];
    // If item is practiceOnly stub, load its data
    if (state.current.practiceOnly) state.current = await loadCardById(state.current.id);
    renderCard(state.current.front, state.current.back);
    setStatus(`Due: ${state.queue.length} card(s)`);
    show('showBtn', true);
  } catch (e) {
    console.error(e); setStatus('Failed to load session.');
  }
}
async function loadCardById(id) {
  const snap = await getDoc(doc(db, 'accounts', state.code, 'cards', id));
  return { id, ...snap.data() };
}

// ---- Show answer & grade flow ----
function showAnswer() {
  if (!state.current) return;
  el('flipInner').classList.add('flipped');
  show('buttons', true);
  show('showBtn', false);
}

// Learning steps in minutes for Again / Hard / Good (index progression)
const LEARNING_STEPS = [1, 10]; // minutes
const HARD_MIN = 5;             // minutes if Hard on same step

function sm2Update(card, q) {
  let ef = card.ef ?? 2.5;
  let reps = card.reps ?? 0;
  let interval = card.interval ?? 0;

  const delta = 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02);
  ef = Math.max(1.3, ef + delta);

  if (q < 3) {
    // lapse: go to learning step 0
    return { ef, reps: 0, interval: 0, due: nowMs() + 60*1000, learning: true, learningStep: 0, learningDue: nowMs() + 60*1000 };
  } else {
    reps += 1;
    if (reps === 1) interval = 1;
    else if (reps === 2) interval = 6;
    else interval = Math.max(1, Math.round(interval * ef));
  }
  const due = nowMs() + interval * 24 * 60 * 60 * 1000;
  return { ef, reps, interval, due, learning: false, learningStep: 0, learningDue: null };
}

async function grade(q) {
  if (!state.current) return;
  const c = state.current;

  // Practice-only pass (after caps are done): do not change schedule
  if (state.mode === 'A' && state.daily.interactions >= state.caps.targetInteractions && state.queue.length > 0) {
    await bumpInteractions(false);
    nextCard();
    return;
  }

  try {
    let updates = {};
    // Learning logic for new/lapsed cards
    if (c.learning || c.reps === 0) {
      let step = c.learning ? (c.learningStep || 0) : 0;
      if (q === 1) { // Again -> back to step 0 (1 min)
        step = 0;
        updates = {
          learning: true,
          learningStep: step,
          learningDue: nowMs() + LEARNING_STEPS[0] * 60 * 1000
        };
      } else if (q === 3) { // Hard -> same step, small wait
        updates = {
          learning: true,
          learningStep: step,
          learningDue: nowMs() + HARD_MIN * 60 * 1000
        };
      } else if (q === 4) { // Good -> advance step or graduate
        step += 1;
        if (step < LEARNING_STEPS.length) {
          updates = {
            learning: true,
            learningStep: step,
            learningDue: nowMs() + LEARNING_STEPS[step] * 60 * 1000
          };
        } else {
          // graduate to SM-2 (first day = 1d)
          const grad = sm2Update({ ...c, reps: Math.max(1, c.reps) }, 4);
          updates = { ...grad };
        }
      } else if (q === 5) { // Easy -> graduate now with a bit of a boost
        const grad = sm2Update({ ...c, ef: (c.ef||2.5)+0.15, reps: Math.max(1,c.reps) }, 5);
        updates = { ...grad };
      }
    } else {
      // Normal SM-2 for review cards
      updates = sm2Update(c, q);
    }

    // Update card doc
    await updateDoc(doc(db, 'accounts', state.code, 'cards', c.id), { ...updates, updatedAt: serverTimestamp() });

    // Tally daily counters
    const wasNew = (c.reps === 0) && !c.learning;
    await bumpInteractions(!wasNew ? true : false, wasNew); // reviewUsed++, maybe newUsed++

    // Add to seenToday set
    if (!state.seenToday.includes(c.id)) state.seenToday.push(c.id);

    // Update teacher summary
    await updateSummaryAfterReview();

    nextCard();
  } catch (e) {
    console.error(e); alert('Failed to save review.');
  }
}

async function bumpInteractions(isReview, isNew=false) {
  const d = state.daily;
  const dkey = todayKey();
  const next = {
    date: dkey,
    newUsed: d.newUsed + (isNew ? 1 : 0),
    reviewUsed: d.reviewUsed + (isReview ? 1 : 0),
    interactions: d.interactions + 1
  };
  state.daily = next;
  await updateDoc(accountRef(), { daily: next });
  setQuotaStatus();
}

async function nextCard() {
  // Remove current from queue; reinsert learning items when due
  state.queue.shift();

  // If queue exhausted: try to build again (more due/learning may have appeared)
  if (state.queue.length === 0) {
    await startSession();
    return;
  }

  // Proceed to next
  state.current = state.queue[0];
  if (state.current.practiceOnly) state.current = await loadCardById(state.current.id);
  resetFlip();
  renderCard(state.current.front, state.current.back);
  show('showBtn', true);
}

// ---- Summaries for teacher dashboard (student writes) ----
async function getTotalCards() {
  const snap = await getCountFromServer(cardsCol());
  return snap.data().count || 0;
}
async function getDueCount() {
  const qDue = query(cardsCol(), where('due', '<=', nowMs()));
  const snap = await getCountFromServer(qDue);
  return snap.data().count || 0;
}
async function updateSummaryCounts() {
  if (!state.code) return;
  const [total, due] = await Promise.all([getTotalCards(), getDueCount()]);
  await setDoc(summariesRef(), {
    code: state.code,
    totalCards: total,
    dueCount: due,
    lastUpdated: serverTimestamp()
  }, { merge: true });
}
async function updateSummaryAfterReview() {
  if (!state.code) return;
  const ref = summariesRef();
  const snap = await getDoc(ref);

  const now = nowMs();
  const today = todayKey();
  let reviewsToday = 0;
  let streak = 1;
  let lastReviewDate = today;

  if (snap.exists()) {
    const data = snap.data();
    const prevDate = data.lastReviewDate || null;
    const prevStreak = data.streak || 0;
    const prevReviewsToday = data.reviewsToday || 0;
    const yesterday = new Date(now - 24*60*60*1000).toISOString().slice(0,10);
    if (prevDate === today) {
      reviewsToday = prevReviewsToday + 1;
      streak = prevStreak || 1;
    } else if (prevDate === yesterday) {
      reviewsToday = 1;
      streak = (prevStreak || 0) + 1;
    } else {
      reviewsToday = 1;
      streak = 1;
    }
    lastReviewDate = today;
  }

  const [total, due] = await Promise.all([getTotalCards(), getDueCount()]);
  await setDoc(ref, {
    code: state.code,
    totalCards: total,
    dueCount: due,
    reviewsToday,
    streak,
    lastReviewAt: now,
    lastReviewDate,
    lastUpdated: serverTimestamp()
  }, { merge: true });
}

// ---- Shared decks: teacher publish & student sync ----
async function teacherLogin() {
  setTeacherLoginStatus('');
  const tCode = el('teacherCodeInput').value.trim();
  if (!tCode) { setTeacherLoginStatus('Enter your teacher code.'); return; }
  try {
    await ensureSignedIn();
    const tSnap = await getDoc(doc(db, 'teacherCodes', tCode));
    if (!tSnap.exists()) { setTeacherLoginStatus('Teacher code not found.'); return; }
    // register teacher session
    await setDoc(doc(db, 'teacherUsers', auth.currentUser.uid), {
      teacherCode: tCode, createdAt: serverTimestamp()
    }, { merge: true });
    state.teacherActive = true;
    show('teacher', true);
    await loadTeacherTable();
  } catch (e) { console.error(e); setTeacherLoginStatus('Login failed.'); }
}

async function loadTeacherTable() {
  const body = el('teacherTableBody');
  body.innerHTML = `<tr><td colspan="7" class="muted">Loading…</td></tr>`;
  try {
    const q = query(collection(db, 'summaries'), orderBy('lastUpdated', 'desc'), limit(500));
    const snap = await getDocs(q);
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (!rows.length) { body.innerHTML = `<tr><td colspan="7" class="muted">No summaries yet.</td></tr>`; return; }
    body.innerHTML = rows.map(r => {
      const last = r.lastReviewAt ? new Date(r.lastReviewAt).toLocaleString() : '—';
      const upd  = r.lastUpdated ? 'just now' : '—';
      return `<tr>
        <td><code>${r.code || r.id}</code></td>
        <td>${r.totalCards ?? 0}</td>
        <td>${r.dueCount ?? 0}</td>
        <td>${r.reviewsToday ?? 0}</td>
        <td>${r.streak ?? 0}</td>
        <td>${last}</td>
        <td class="muted">${upd}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    console.error(e);
    body.innerHTML = `<tr><td colspan="7" class="muted">Failed to load (check rules & teacher code).</td></tr>`;
  }
}

// Import JSON -> publish into /sharedDecks/{HSK2|HSK3}/cards/*
async function readFileAsJSON(inputEl) {
  return new Promise((resolve, reject) => {
    const f = inputEl.files[0]; if (!f) return resolve(null);
    const r = new FileReader();
    r.onload = e => { try { resolve(JSON.parse(e.target.result)); } catch (err) { reject(err); } };
    r.onerror = reject;
    r.readAsText(f);
  });
}
async function publishDeck(deckId, inputEl) {
  try {
    const data = await readFileAsJSON(inputEl);
    if (!data || !Array.isArray(data)) { alert('Choose a JSON array of cards: [{front,back}]'); return; }
    // Write in small batches to Firestore
    let count = 0;
    for (const c of data) {
      if (!c.front || !c.back) continue;
      await addDoc(sharedDeckCol(deckId), {
        front: String(c.front), back: String(c.back), deck: deckId,
        createdAt: serverTimestamp()
      });
      count++;
    }
    alert(`Published ${count} cards to shared deck ${deckId}.`);
  } catch (e) { console.error(e); alert('Publish failed.'); }
}

// Students: auto-sync on login if not synced yet (or when pressing "Force Sync")
async function autoSyncSharedDecks() {
  const acc = await getDoc(accountRef());
  const synced = (acc.exists() && acc.data().syncedDecks) ? acc.data().syncedDecks : {};
  const deckIds = ['HSK2', 'HSK3']; // Full = union; no separate sync needed

  for (const deckId of deckIds) {
    if (synced[deckId]) continue;
    const snap = await getDocs(sharedDeckCol(deckId));
    const toCopy = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    for (const c of toCopy) {
      await addDoc(cardsCol(), {
        front: c.front, back: c.back, deck: deckId,
        ef: 2.5, reps: 0, interval: 0, due: nowMs(),
        learning: false, learningStep: 0, learningDue: null,
        suspended: false, flagged: false,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      });
    }
    // mark as synced
    await updateDoc(accountRef(), { [`syncedDecks.${deckId}`]: true });
  }
  await updateSummaryCounts();
}

// ---- UI events & init ----
onAuthStateChanged(auth, async (user) => {
  state.user = user || null;
  if (state.code && user) {
    el('whoCode').textContent = state.code;
    show('login', false);
    show('whoami', true);
    show('studyControls', true);
    show('add-card', true);
    show('study', true);
    show('manage', true);
    await loadDaily();
    setQuotaStatus();
    renderCard('Click "Start Session" to begin.', '');
  }
});

el('loginBtn').addEventListener('click', login);
el('logoutBtn').addEventListener('click', logout);
el('addBtn').addEventListener('click', addCard);
el('exportBtn').addEventListener('click', exportCards);
el('importFile').addEventListener('change', importCardsFile);

el('deckSelect').addEventListener('change', (e)=>{ state.selectedDeck = e.target.value; });
el('modeSelect').addEventListener('change', async (e)=>{ state.mode = e.target.value; setCapsFromMode(); await loadDaily(); setQuotaStatus(); });

el('refreshBtn').addEventListener('click', updateSummaryCounts);
el('startBtn').addEventListener('click', startSession);
el('showBtn').addEventListener('click', showAnswer);
el('btnAgain').addEventListener('click', () => grade(1));
el('btnHard').addEventListener('click',  () => grade(3));
el('btnGood').addEventListener('click',  () => grade(4));
el('btnEasy').addEventListener('click',  () => grade(5));

el('teacherLoginBtn').addEventListener('click', teacherLogin);
el('teacherRefreshBtn').addEventListener('click', loadTeacherTable);
el('publishHSK2').addEventListener('click', () => publishDeck('HSK2', el('hsk2Import')));
el('publishHSK3').addEventListener('click', () => publishDeck('HSK3', el('hsk3Import')));
el('syncAll').addEventListener('click', autoSyncSharedDecks);

// Initial UI
if (!state.code) {
  show('login', true);
  show('whoami', false);
  show('studyControls', false);
  show('add-card', false);
  show('study', false);
  show('manage', false);
} else {
  ensureSignedIn().catch(() => {});
}
