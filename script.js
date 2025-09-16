// --- 1. SUPABASE SETUP ---
const SUPABASE_URL = 'https://ttitgpowrqziacmgeqyf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0aXRncG93cnF6aWFjbWdlcXlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgwNTI5NTUsImV4cCI6MjA3MzYyODk1NX0.AqfzR__R5zPE9VtZCzyvO87oBAbPpKv7RcyiVWAKOXM';

const supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// --- 2. GLOBAL VARIABLES & DOM ELEMENTS ---
let dueCards = [];
let currentCardIndex = 0;
let loggedInStudentId = null;

// Views
const loginContainer = document.getElementById('login-container');
const appContainer = document.getElementById('app-container');

// App Elements
const cardContentEl = document.getElementById('card-content');
const showAnswerBtn = document.getElementById('show-answer-btn');
const ratingButtonsEl = document.getElementById('rating-buttons');
const addCardForm = document.getElementById('add-card-form');
const newQuestionInput = document.getElementById('new-question');
const newAnswerInput = document.getElementById('new-answer');
const loggedInStudentEl = document.getElementById('logged-in-student');
const logoutBtn = document.getElementById('logout-btn');

// Login Elements
const loginForm = document.getElementById('login-form');
const studentIdInput = document.getElementById('student-id-input');


// --- 3. LOGIN/LOGOUT & INITIALIZATION ---

/**
 * Checks for a student ID in session storage on page load.
 */
function checkLoginStatus() {
    const studentId = sessionStorage.getItem('studentId');
    if (studentId) {
        loggedInStudentId = studentId;
        showAppView();
        fetchDueCards();
    } else {
        showLoginView();
    }
}

/**
 * Handles the login form submission.
 */
function handleLogin(event) {
    event.preventDefault();
    const studentId = studentIdInput.value.trim();
    const idPattern = /^Mand\d{4}$/; // Matches "Mand" followed by exactly 4 numbers

    if (idPattern.test(studentId)) {
        loggedInStudentId = studentId;
        sessionStorage.setItem('studentId', studentId); // Save ID for the session
        showAppView();
        fetchDueCards();
    } else {
        alert('Invalid ID format. Please use the format: Mand#### (e.g., Mand1234)');
    }
}

/**
 * Handles logging out.
 */
function handleLogout() {
    sessionStorage.removeItem('studentId');
    loggedInStudentId = null;
    location.reload(); // Easiest way to reset the state
}

function showLoginView() {
    loginContainer.classList.remove('hidden');
    appContainer.classList.add('hidden');
}

function showAppView() {
    loggedInStudentEl.textContent = `Student: ${loggedInStudentId}`;
    loginContainer.classList.add('hidden');
    appContainer.classList.remove('hidden');
}


// --- 4. CORE APP FUNCTIONS (NOW WITH STUDENT ID) ---

/**
 * Fetches cards from Supabase for the logged-in student.
 */
async function fetchDueCards() {
    const today = new Date().toISOString();
    const { data, error } = await supabase
        .from('cards')
        .select('*')
        .eq('student_id', loggedInStudentId) // IMPORTANT: Only get cards for this student
        .lte('next_review_date', today)
        .order('next_review_date', { ascending: true });

    if (error) {
        console.error('Error fetching cards:', error);
        return;
    }

    dueCards = data;
    currentCardIndex = 0;
    displayCard();
}

/**
 * Displays the current card or a "done" message.
 */
function displayCard() {
    if (currentCardIndex >= dueCards.length) {
        cardContentEl.innerHTML = '<h2>🎉 You are done for today!</h2>';
        showAnswerBtn.classList.add('hidden');
        ratingButtonsEl.classList.add('hidden');
        return;
    }
    
    const card = dueCards[currentCardIndex];
    cardContentEl.innerHTML = `<div id="card-question">${card.question}</div>`;
    showAnswerBtn.classList.remove('hidden');
    ratingButtonsEl.classList.add('hidden');
}

/**
 * Shows the answer for the current card.
 */
function showAnswer() {
    const card = dueCards[currentCardIndex];
    cardContentEl.innerHTML += `<div id="card-answer">${card.answer}</div>`;
    showAnswerBtn.classList.add('hidden');
    ratingButtonsEl.classList.remove('hidden');
}

/**
 * Updates a card's review data based on user's rating.
 */
async function updateCard(quality) {
    const card = dueCards[currentCardIndex];
    let { easiness_factor, repetitions, interval } = card;

    if (quality < 3) {
        repetitions = 0;
        interval = 1;
    } else {
        repetitions += 1;
        easiness_factor = easiness_factor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
        if (easiness_factor < 1.3) easiness_factor = 1.3;

        if (repetitions === 1) {
            interval = 1;
        } else if (repetitions === 2) {
            interval = 6;
        } else {
            interval = Math.ceil(interval * easiness_factor);
        }
    }
    
    const nextReviewDate = new Date();
    nextReviewDate.setDate(nextReviewDate.getDate() + interval);

    const { error } = await supabase
        .from('cards')
        .update({
            easiness_factor: easiness_factor,
            repetitions: repetitions,
            interval: interval,
            next_review_date: nextReviewDate.toISOString()
        })
        .eq('id', card.id);

    if (error) {
        console.error('Error updating card:', error);
    } else {
        currentCardIndex++;
        displayCard();
    }
}

/**
 * Adds a new card to the Supabase database for the logged-in student.
 */
async function addCard(event) {
    event.preventDefault();
    const question = newQuestionInput.value;
    const answer = newAnswerInput.value;

    if (!question || !answer) {
        alert('Please provide both a question and an answer.');
        return;
    }

    const { error } = await supabase
        .from('cards')
        .insert([{ 
            question: question, 
            answer: answer,
            student_id: loggedInStudentId // IMPORTANT: Tag the new card with the student's ID
        }]);

    if (error) {
        console.error('Error adding card:', error);
    } else {
        alert('Card added successfully!');
        newQuestionInput.value = '';
        newAnswerInput.value = '';
    }
}


// --- 5. EVENT LISTENERS ---

// When the page loads, check if the user is already logged in
document.addEventListener('DOMContentLoaded', checkLoginStatus);

// Login/Logout listeners
loginForm.addEventListener('submit', handleLogin);
logoutBtn.addEventListener('click', handleLogout);

// App listeners
showAnswerBtn.addEventListener('click', showAnswer);
ratingButtonsEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('rating-btn')) {
        const quality = parseInt(e.target.dataset.quality, 10);
        updateCard(quality);
    }
});
addCardForm.addEventListener('submit', addCard);