(function() {
  if (typeof TEST_CONFIG === "undefined" || typeof ALL_QUESTIONS === "undefined") {
    document.getElementById("app").innerHTML = '<p style="color:red;padding:40px;text-align:center">Error: No question pack loaded.</p>';
    return;
  }

  var CONFIG = {
    title: TEST_CONFIG.title || "Practice Test",
    subtitle: TEST_CONFIG.subtitle || "",
    sections: TEST_CONFIG.sections || [],
    totalQuestions: TEST_CONFIG.totalQuestions || 100,
    passingPct: TEST_CONFIG.passingPct || 70,
    showCalculator: TEST_CONFIG.showCalculator !== false,
    saveKey: TEST_CONFIG.saveKey || "test_progress",
    defaultTimerMinutes: TEST_CONFIG.defaultTimerMinutes || 120,
    adminPasscodeHash: TEST_CONFIG.adminPasscodeHash || "",
    footer: TEST_CONFIG.footer || ""
  };

  var state = {
    screen: "start",
    mode: null,
    questions: [],
    current: 0,
    answers: {},
    graded: {},
    timerSeconds: 0,
    timerInterval: null,
    timerWarningShown: false,
    startTime: null,
    adminConfig: null,
    showConfirm: false
  };

  var LABELS = ["A", "B", "C", "D"];
  var adminUnlocked = false;

  // --- Utility functions ---

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
    }
    return a;
  }

  function selectQuestions(numQuestions) {
    var selected = [];
    for (var s = 0; s < CONFIG.sections.length; s++) {
      var sec = CONFIG.sections[s];
      var pool = ALL_QUESTIONS.filter(function(q) { return q.section === sec.name; });
      var picked = shuffle(pool).slice(0, sec.count);
      selected.push.apply(selected, picked);
    }
    return shuffle(selected).slice(0, numQuestions);
  }

  function esc(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function saveProgress() {
    if (state.mode !== "practice") return;
    try {
      localStorage.setItem(CONFIG.saveKey, JSON.stringify({
        questions: state.questions,
        current: state.current,
        answers: state.answers,
        graded: state.graded
      }));
    } catch (e) {}
  }

  function loadProgress() {
    try {
      var d = localStorage.getItem(CONFIG.saveKey);
      return d ? JSON.parse(d) : null;
    } catch (e) {
      return null;
    }
  }

  function clearProgress() {
    try { localStorage.removeItem(CONFIG.saveKey); } catch (e) {}
  }

  function getRunningScore() {
    var total = Object.keys(state.graded).length;
    if (total === 0) return { correct: 0, incorrect: 0, total: 0, pct: 0 };
    var correct = 0;
    for (var k in state.graded) {
      if (state.graded[k] === true) correct++;
    }
    return { correct: correct, incorrect: total - correct, total: total, pct: Math.round((correct / total) * 100) };
  }

  // --- Passcode hashing ---

  function hashPasscode(input, callback) {
    if (window.crypto && window.crypto.subtle) {
      var encoded = new TextEncoder().encode(input);
      crypto.subtle.digest("SHA-256", encoded).then(function(buf) {
        var arr = Array.from(new Uint8Array(buf));
        callback(arr.map(function(b) { return b.toString(16).padStart(2, "0"); }).join(""));
      });
    } else {
      callback(btoa(input));
    }
  }

  // --- Timer system ---

  function startTimer(minutes) {
    state.timerSeconds = minutes * 60;
    state.startTime = Date.now();
    state.timerWarningShown = false;
    state.timerInterval = setInterval(tickTimer, 1000);
  }

  function tickTimer() {
    state.timerSeconds--;
    var el = document.getElementById("timer-display");
    if (el) {
      el.textContent = formatTime(state.timerSeconds);
      var bar = document.getElementById("timer-bar");
      if (state.timerSeconds <= 300 && bar) {
        bar.classList.add("warning");
      }
    }
    if (state.timerSeconds <= 0) {
      clearInterval(state.timerInterval);
      submitTest();
    }
  }

  function formatTime(secs) {
    if (secs < 0) secs = 0;
    var h = Math.floor(secs / 3600);
    var m = Math.floor((secs % 3600) / 60);
    var s = secs % 60;
    if (h > 0) return h + ":" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function stopTimer() {
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
  }

  // --- Render dispatcher ---

  function render() {
    var app = document.getElementById("app");
    if (state.screen === "start") renderStart(app);
    else if (state.screen === "admin") renderAdmin(app);
    else if (state.screen === "test") renderTest(app);
    else if (state.screen === "results") renderResults(app);
  }

  // --- Start screen ---

  function renderStart(app) {
    showCalcBtn(false);

    var saved = loadProgress();
    var hasSaved = saved !== null;

    var html = '<div class="container"><div class="start-screen">';
    html += '<h1>' + esc(CONFIG.title) + '</h1>';
    if (CONFIG.subtitle) {
      html += '<div class="subtitle">' + esc(CONFIG.subtitle) + '</div>';
    }

    if (hasSaved) {
      html += '<div class="resume-banner">';
      html += '<p>You have a test in progress. Pick up where you left off?</p>';
      html += '<div class="resume-buttons">';
      html += '<button class="btn btn-small" onclick="resumeTest()">Resume Test</button>';
      html += '<button class="btn btn-secondary btn-small" onclick="discardSaved()">Discard &amp; Start Fresh</button>';
      html += '</div></div>';
    }

    html += '<div class="overview-box">';
    html += '<h2>Exam Overview</h2>';
    html += '<p>Each attempt randomly draws ' + CONFIG.totalQuestions + ' questions from a bank of ' + ALL_QUESTIONS.length.toLocaleString() + ' questions, weighted by section percentages.</p>';
    html += '<table><thead><tr><th>Content Area</th><th style="text-align:center">Weight</th><th style="text-align:center">Questions</th><th style="text-align:center">Bank Size</th></tr></thead><tbody>';

    var totalCount = 0;
    for (var i = 0; i < CONFIG.sections.length; i++) {
      var sec = CONFIG.sections[i];
      totalCount += sec.count;
      html += '<tr><td>' + esc(sec.name) + '</td><td class="pct">' + esc(sec.pct) + '</td><td class="count">' + sec.count + '</td><td class="count">' + sec.total + '</td></tr>';
    }
    html += '<tr style="font-weight:700;border-top:2px solid var(--gold-dark)"><td>Total</td><td class="pct">100%</td><td class="count">' + CONFIG.totalQuestions + '</td><td class="count">' + ALL_QUESTIONS.length.toLocaleString() + '</td></tr>';
    html += '</tbody></table>';

    var neededToPass = Math.ceil(CONFIG.totalQuestions * CONFIG.passingPct / 100);
    html += '<div style="text-align:center;margin-top:8px"><span style="color:var(--gray);font-size:0.85rem">Passing Score: ' + CONFIG.passingPct + '% (' + neededToPass + ' of ' + CONFIG.totalQuestions + ' correct)</span></div>';
    html += '</div>';

    html += '<div class="mode-buttons">';
    html += '<button class="mode-btn" onclick="startTest()"><h3>Practice Mode</h3><p>Study at your own pace. Instant feedback on every question. Progress saved automatically.</p></button>';
    html += '<button class="mode-btn" onclick="goAdmin()"><h3>Final Exam Mode</h3><p>Timed exam with professor settings. No feedback until submission.</p></button>';
    html += '</div>';

    if (CONFIG.footer) {
      html += '<div class="footer">' + CONFIG.footer + '</div>';
    }

    html += '</div></div>';
    app.innerHTML = html;
  }

  // --- Admin screen ---

  function renderAdmin(app) {
    showCalcBtn(false);

    var html = '<div class="container"><div class="start-screen">';
    html += '<h1>Final Exam Setup</h1>';

    html += '<div class="admin-panel">';

    if (CONFIG.adminPasscodeHash && !adminUnlocked) {
      html += '<h2>Enter Passcode</h2>';
      html += '<div class="admin-field"><label>Professor Passcode</label><input type="password" id="admin-passcode" placeholder="Enter passcode"></div>';
      html += '<div class="admin-error" id="admin-error"></div>';
      html += '<div class="admin-buttons">';
      html += '<button class="btn btn-small" onclick="unlockAdmin()">Unlock</button>';
      html += '<button class="btn btn-secondary btn-small" onclick="goHome()">Back</button>';
      html += '</div>';
    } else {
      html += '<h2>Configure Exam</h2>';
      html += '<div class="admin-field"><label>Timer (minutes)</label><input type="number" id="admin-timer" value="' + CONFIG.defaultTimerMinutes + '" min="1"></div>';
      html += '<div class="admin-field"><label>Passing Score (%)</label><input type="number" id="admin-passing" value="' + CONFIG.passingPct + '" min="1" max="100"></div>';
      html += '<div class="admin-field"><label>Number of Questions</label><input type="number" id="admin-numq" value="' + CONFIG.totalQuestions + '" min="1" max="' + ALL_QUESTIONS.length + '"></div>';
      html += '<div class="admin-field"><label class="checkbox-row"><input type="checkbox" id="admin-calc"' + (CONFIG.showCalculator ? ' checked' : '') + '><span>Show Calculator</span></label></div>';
      html += '<div class="admin-buttons">';
      html += '<button class="btn btn-small" onclick="launchExam()">Launch Exam</button>';
      html += '<button class="btn btn-secondary btn-small" onclick="goHome()">Back</button>';
      html += '</div>';
    }

    html += '</div></div></div>';
    app.innerHTML = html;
  }

  // --- Test screen ---

  function renderTest(app) {
    var q = state.questions[state.current];
    var answered = Object.keys(state.answers).length;
    var totalQ = state.questions.length;
    var isPractice = state.mode === "practice";
    var isGraded = state.graded[state.current] !== undefined;
    var wasCorrect = state.graded[state.current] === true;

    var calcAllowed = isPractice ? CONFIG.showCalculator :
      (state.adminConfig ? state.adminConfig.showCalculator : CONFIG.showCalculator);
    showCalcBtn(calcAllowed);

    var html = '<div class="container">';

    // Timer bar for final mode
    if (!isPractice) {
      html += '<div class="timer-bar" id="timer-bar">';
      html += '<div><span class="timer-label">Time Remaining</span></div>';
      html += '<div class="timer-display" id="timer-display">' + formatTime(state.timerSeconds) + '</div>';
      html += '</div>';
    }

    // Header
    html += '<div style="margin-bottom:8px"><h1 style="font-size:1.2rem;margin-bottom:4px">' + esc(CONFIG.title) + ' &mdash; ' + (isPractice ? 'Practice Mode' : 'Final Exam') + '</h1></div>';

    // Progress
    html += '<div class="progress-text"><span>Question ' + (state.current + 1) + ' of ' + totalQ + '</span><span>' + answered + ' answered</span></div>';
    html += '<div class="progress-bar-wrap"><div class="progress-bar-fill" style="width:' + ((answered / totalQ) * 100) + '%"></div></div>';

    // Running score (practice) or unanswered count (final)
    if (isPractice) {
      var running = getRunningScore();
      if (running.total > 0) {
        html += '<div class="running-score">';
        html += '<span class="sc sc-g">' + running.correct + ' correct</span>';
        html += '<span class="sc sc-r">' + running.incorrect + ' missed</span>';
        html += '<span class="sc sc-y">' + running.pct + '%</span>';
        html += '</div>';
      }
    } else {
      var unanswered = totalQ - answered;
      if (unanswered > 0) {
        html += '<div class="running-score"><span class="unanswered-count">' + unanswered + ' unanswered</span></div>';
      }
    }

    // Question card
    html += '<div class="question-card">';
    html += '<div class="question-header"><span class="section-badge">' + esc(q.section) + '</span><span style="color:var(--gray);font-size:0.85rem">#' + (state.current + 1) + '</span></div>';
    html += '<div class="question-text">' + esc(q.question) + '</div>';
    html += '<div class="options">';

    for (var i = 0; i < q.options.length; i++) {
      var cls = "option";
      var clickAttr = "";

      if (isPractice) {
        if (isGraded) {
          cls += " locked";
          if (i === q.correct) cls += " correct-reveal";
          else if (i === state.answers[state.current] && !wasCorrect) cls += " incorrect-reveal";
        } else if (state.answers[state.current] === i) {
          cls += " selected";
        }
        clickAttr = ' onclick="selectAnswer(' + i + ')"';
      } else {
        if (state.answers[state.current] === i) cls += " selected";
        clickAttr = ' onclick="selectAnswer(' + i + ')"';
      }

      html += '<div class="' + cls + '"' + clickAttr + '>';
      html += '<div class="radio"></div>';
      html += '<span class="option-label">' + LABELS[i] + '.</span>';
      html += '<span>' + esc(q.options[i]) + '</span>';
      html += '</div>';
    }

    html += '</div>';

    // Feedback (practice mode only)
    if (isPractice && isGraded && wasCorrect) {
      html += '<div class="feedback-box feedback-correct">';
      html += '<div class="fb-label">&#10003; Correct!</div>';
      html += '<div class="fb-explain">' + esc(q.explanation) + '</div>';
      html += '</div>';
    }
    if (isPractice && isGraded && !wasCorrect) {
      html += '<div class="feedback-box feedback-incorrect">';
      html += '<div class="fb-label">&#10007; Incorrect</div>';
      html += '<div class="fb-correct">Correct answer: ' + LABELS[q.correct] + '. ' + esc(q.options[q.correct]) + '</div>';
      html += '<div class="fb-explain">' + esc(q.explanation) + '</div>';
      html += '</div>';
    }

    html += '</div>';

    // Navigation buttons
    html += '<div class="nav-buttons">';
    html += '<button class="nav-btn"' + (state.current === 0 ? ' disabled' : '') + ' onclick="goPrev()">&#8592; Previous</button>';
    html += '<div class="question-nav">' + (state.current + 1) + ' / ' + totalQ + '</div>';

    if (isPractice) {
      var allAnswered = answered === totalQ;
      if (state.current < totalQ - 1) {
        html += '<button class="nav-btn" onclick="goNext()">Next &#8594;</button>';
      } else if (allAnswered) {
        html += '<button class="submit-btn" onclick="submitTest()">Finish &amp; See Results</button>';
      } else {
        html += '<button class="nav-btn" disabled>Answer all to finish</button>';
      }
    } else {
      if (state.current < totalQ - 1) {
        html += '<button class="nav-btn" onclick="goNext()">Next &#8594;</button>';
      } else {
        html += '<button class="submit-btn" onclick="trySubmit()">Submit Test</button>';
      }
    }

    html += '</div>';

    // Submit button also in final mode (always accessible)
    if (!isPractice && state.current < totalQ - 1) {
      html += '<div style="text-align:center;margin-top:16px"><button class="btn btn-small" onclick="trySubmit()">Submit Test</button></div>';
    }

    if (CONFIG.footer) {
      html += '<div class="footer">' + CONFIG.footer + '</div>';
    }

    html += '</div>';

    // Confirm dialog overlay
    if (state.showConfirm) {
      var unansweredCount = totalQ - answered;
      html += '<div class="confirm-overlay">';
      html += '<div class="confirm-box">';
      html += '<h3>Submit with unanswered questions?</h3>';
      html += '<p>You have ' + unansweredCount + ' of ' + totalQ + ' questions unanswered. Unanswered questions will be marked incorrect.</p>';
      html += '<div class="confirm-buttons">';
      html += '<button class="btn btn-small" onclick="submitTest()">Submit Anyway</button>';
      html += '<button class="btn btn-secondary btn-small" onclick="cancelSubmit()">Go Back</button>';
      html += '</div></div></div>';
    }

    app.innerHTML = html;
  }

  // --- Results screen ---

  function renderResults(app) {
    showCalcBtn(false);

    var isPractice = state.mode === "practice";
    var totalQ = state.questions.length;
    var correct = 0;
    var incorrect = [];

    for (var i = 0; i < totalQ; i++) {
      if (state.answers[i] === state.questions[i].correct) {
        correct++;
      } else {
        incorrect.push({ index: i, question: state.questions[i], userAnswer: state.answers[i] });
      }
    }

    var score = totalQ > 0 ? correct / totalQ : 0;
    var passingPct = (!isPractice && state.adminConfig && state.adminConfig.passingPct) ? state.adminConfig.passingPct : CONFIG.passingPct;
    var passed = (score * 100) >= passingPct;
    var neededToPass = Math.ceil(totalQ * passingPct / 100);

    // Section scores
    var sectionScores = {};
    for (var s = 0; s < CONFIG.sections.length; s++) {
      sectionScores[CONFIG.sections[s].name] = { correct: 0, total: 0 };
    }
    for (var j = 0; j < totalQ; j++) {
      var sec = state.questions[j].section;
      if (!sectionScores[sec]) sectionScores[sec] = { correct: 0, total: 0 };
      sectionScores[sec].total++;
      if (state.answers[j] === state.questions[j].correct) sectionScores[sec].correct++;
    }

    var html = '<div class="container">';

    // Results header
    html += '<div class="results-header">';
    html += '<h1>Test Results</h1>';
    html += '<div class="score-display ' + (passed ? 'pass' : 'fail') + '">' + Math.round(score * 100) + '%</div>';
    html += '<div class="pass-fail ' + (passed ? 'pass' : 'fail') + '">' + (passed ? 'PASSED' : 'DID NOT PASS') + '</div>';
    html += '</div>';

    // Summary stats
    html += '<div class="results-summary">';
    html += '<div class="stat-card"><div class="stat-value">' + correct + '</div><div class="stat-label">Correct</div></div>';
    html += '<div class="stat-card"><div class="stat-value">' + (totalQ - correct) + '</div><div class="stat-label">Incorrect</div></div>';
    html += '<div class="stat-card"><div class="stat-value">' + totalQ + '</div><div class="stat-label">Total</div></div>';
    html += '<div class="stat-card"><div class="stat-value">' + neededToPass + '</div><div class="stat-label">Needed to Pass</div></div>';
    html += '</div>';

    // Elapsed time for final mode
    if (!isPractice && state.startTime) {
      var elapsed = Math.round((Date.now() - state.startTime) / 1000);
      var timerMinutes = (state.adminConfig && state.adminConfig.timerMinutes) ? state.adminConfig.timerMinutes : CONFIG.defaultTimerMinutes;
      var totalTimerSecs = timerMinutes * 60;
      if (elapsed > totalTimerSecs) elapsed = totalTimerSecs;
      html += '<div style="text-align:center;margin:16px 0;color:var(--gray);font-size:0.9rem">Time used: ' + formatTime(elapsed) + ' of ' + formatTime(totalTimerSecs) + '</div>';
    }

    // Section breakdown
    html += '<div style="margin:24px 0"><h2>Score by Section</h2>';
    for (var k = 0; k < CONFIG.sections.length; k++) {
      var secName = CONFIG.sections[k].name;
      var sc = sectionScores[secName];
      if (!sc) continue;
      var pct = sc.total > 0 ? (sc.correct / sc.total) * 100 : 0;
      var color = pct >= 70 ? 'var(--green)' : pct >= 50 ? 'var(--gold)' : 'var(--red)';
      html += '<div class="section-score">';
      html += '<span class="section-score-name">' + esc(secName) + '</span>';
      html += '<div class="section-score-bar"><div class="section-score-fill" style="width:' + pct + '%;background:' + color + '"></div></div>';
      html += '<span class="section-score-pct" style="color:' + color + '">' + sc.correct + '/' + sc.total + '</span>';
      html += '</div>';
    }
    html += '</div>';

    // Incorrect answers
    if (incorrect.length > 0) {
      html += '<div style="margin:24px 0"><h2>Incorrect Answers (' + incorrect.length + ')</h2>';
      for (var m = 0; m < incorrect.length; m++) {
        var item = incorrect[m];
        html += '<div class="incorrect-item">';
        html += '<div class="q-num">' + esc(item.question.section) + ' &mdash; Question ' + (item.index + 1) + '</div>';
        html += '<div class="q-text">' + esc(item.question.question) + '</div>';
        if (item.userAnswer !== undefined) {
          html += '<div class="your-answer">Your answer: ' + LABELS[item.userAnswer] + '. ' + esc(item.question.options[item.userAnswer]) + '</div>';
        } else {
          html += '<div class="your-answer">No answer provided</div>';
        }
        html += '<div class="correct-answer">Correct answer: ' + LABELS[item.question.correct] + '. ' + esc(item.question.options[item.question.correct]) + '</div>';
        html += '<div class="explanation">' + esc(item.question.explanation) + '</div>';
        html += '</div>';
      }
      html += '</div>';
    }

    // Action buttons
    html += '<div style="text-align:center;margin:30px 0">';
    if (isPractice) {
      html += '<button class="btn" onclick="startTest()">Retake Test</button>';
      html += '<div style="margin-top:12px"><button class="btn btn-secondary btn-small" onclick="goHome()">Back to Home</button></div>';
    } else {
      html += '<button class="btn" onclick="goHome()">Back to Home</button>';
    }
    html += '</div>';

    if (CONFIG.footer) {
      html += '<div class="footer">' + CONFIG.footer + '</div>';
    }

    html += '</div>';
    app.innerHTML = html;
  }

  // --- Answer handling ---

  function selectAnswer(idx) {
    if (state.mode === "practice") {
      if (state.graded[state.current] !== undefined) return;
      state.answers[state.current] = idx;
      state.graded[state.current] = (idx === state.questions[state.current].correct);
      saveProgress();
    } else {
      state.answers[state.current] = idx;
    }
    render();
  }

  // --- Navigation ---

  function goPrev() {
    if (state.current > 0) {
      state.current--;
      window.scrollTo(0, 0);
      render();
    }
  }

  function goNext() {
    if (state.current < state.questions.length - 1) {
      state.current++;
      window.scrollTo(0, 0);
      render();
    }
  }

  function goAdmin() {
    state.screen = "admin";
    window.scrollTo(0, 0);
    render();
  }

  function goHome() {
    stopTimer();
    state.screen = "start";
    state.mode = null;
    window.scrollTo(0, 0);
    render();
  }

  function resumeTest() {
    var saved = loadProgress();
    if (saved) {
      state.mode = "practice";
      state.questions = saved.questions;
      state.current = saved.current;
      state.answers = saved.answers || {};
      state.graded = saved.graded || {};
      state.screen = "test";
      state.adminConfig = null;
      window.scrollTo(0, 0);
      render();
    }
  }

  function discardSaved() {
    clearProgress();
    render();
  }

  // --- Start modes ---

  function startTest() {
    state.mode = "practice";
    state.questions = selectQuestions(CONFIG.totalQuestions);
    state.answers = {};
    state.graded = {};
    state.current = 0;
    state.screen = "test";
    state.adminConfig = null;
    clearProgress();
    saveProgress();
    window.scrollTo(0, 0);
    render();
  }

  function startFinalExam() {
    var ac = state.adminConfig;
    state.mode = "final";
    state.questions = selectQuestions(ac.numQuestions || CONFIG.totalQuestions);
    state.answers = {};
    state.graded = {};
    state.current = 0;
    state.screen = "test";
    state.showConfirm = false;
    window.scrollTo(0, 0);
    render();
    startTimer(ac.timerMinutes || CONFIG.defaultTimerMinutes);
  }

  // --- Submit ---

  function submitTest() {
    stopTimer();
    clearProgress();
    state.screen = "results";
    state.showConfirm = false;
    window.scrollTo(0, 0);
    render();
  }

  function trySubmit() {
    var answered = Object.keys(state.answers).length;
    if (state.mode === "final" && answered < state.questions.length) {
      state.showConfirm = true;
      render();
    } else {
      submitTest();
    }
  }

  function cancelSubmit() {
    state.showConfirm = false;
    render();
  }

  // --- Admin unlock and launch ---

  function unlockAdmin() {
    var input = document.getElementById("admin-passcode").value;
    if (!CONFIG.adminPasscodeHash) {
      adminUnlocked = true;
      render();
      return;
    }
    hashPasscode(input, function(hash) {
      if (hash === CONFIG.adminPasscodeHash) {
        adminUnlocked = true;
        render();
      } else {
        var err = document.getElementById("admin-error");
        if (err) err.textContent = "Incorrect passcode. Try again.";
      }
    });
  }

  function launchExam() {
    var timer = parseInt(document.getElementById("admin-timer").value) || CONFIG.defaultTimerMinutes;
    var passing = parseInt(document.getElementById("admin-passing").value) || CONFIG.passingPct;
    var numQ = parseInt(document.getElementById("admin-numq").value) || CONFIG.totalQuestions;
    var showCalc = document.getElementById("admin-calc").checked;
    state.adminConfig = { timerMinutes: timer, passingPct: passing, numQuestions: numQ, showCalculator: showCalc };
    startFinalExam();
  }

  // --- Calculator ---

  var calcExpr = "";
  var calcNew = true;

  function toggleCalc() {
    var c = document.getElementById("calculator");
    if (c) c.classList.toggle("open");
  }

  function calcUpdateDisplay() {
    var d = document.getElementById("calcDisplay");
    if (d) d.textContent = calcExpr || "0";
  }

  function calcClear() {
    calcExpr = "";
    calcNew = true;
    calcUpdateDisplay();
  }

  function calcInput(ch) {
    if (calcNew && ch !== ".") {
      calcExpr = "";
      calcNew = false;
    }
    calcExpr += ch;
    calcUpdateDisplay();
  }

  function calcOp(op) {
    calcNew = false;
    calcExpr += " " + op + " ";
    calcUpdateDisplay();
  }

  function calcPercent() {
    try {
      var val = Function('"use strict"; return (' + calcExpr + ')')();
      calcExpr = String(val / 100);
      calcNew = true;
      calcUpdateDisplay();
    } catch (e) {
      calcExpr = "Error";
      calcNew = true;
      calcUpdateDisplay();
    }
  }

  function calcEquals() {
    try {
      var expr = calcExpr.replace(/\u00d7/g, "*").replace(/\u00f7/g, "/").replace(/\u2212/g, "-");
      var val = Function('"use strict"; return (' + expr + ')')();
      calcExpr = String(Math.round(val * 1e10) / 1e10);
      calcNew = true;
      calcUpdateDisplay();
    } catch (e) {
      calcExpr = "Error";
      calcNew = true;
      calcUpdateDisplay();
    }
  }

  function showCalcBtn(show) {
    var calcAllowed = state.mode === "practice" ? CONFIG.showCalculator :
      (state.adminConfig ? state.adminConfig.showCalculator : CONFIG.showCalculator);
    var btn = document.getElementById("calcToggle");
    if (btn) btn.style.display = (show && calcAllowed) ? "flex" : "none";
    if (!show || !calcAllowed) {
      var c = document.getElementById("calculator");
      if (c) c.classList.remove("open");
    }
  }

  function initCalculator() {
    var html = '<button class="calc-toggle" id="calcToggle" onclick="toggleCalc()" title="Calculator" style="display:none">&#128290;</button>' +
    '<div class="calculator" id="calculator">' +
    '<div class="calc-header"><span>Calculator</span><button class="calc-close" onclick="toggleCalc()">&times;</button></div>' +
    '<div class="calc-display" id="calcDisplay">0</div>' +
    '<div class="calc-buttons">' +
    '<button class="calc-btn clear" onclick="calcClear()">C</button>' +
    '<button class="calc-btn op" onclick="calcInput(\'(\')"> (</button>' +
    '<button class="calc-btn op" onclick="calcInput(\')\')">)</button>' +
    '<button class="calc-btn op" onclick="calcOp(\'/\')">&divide;</button>' +
    '<button class="calc-btn" onclick="calcInput(\'7\')">7</button>' +
    '<button class="calc-btn" onclick="calcInput(\'8\')">8</button>' +
    '<button class="calc-btn" onclick="calcInput(\'9\')">9</button>' +
    '<button class="calc-btn op" onclick="calcOp(\'*\')">&times;</button>' +
    '<button class="calc-btn" onclick="calcInput(\'4\')">4</button>' +
    '<button class="calc-btn" onclick="calcInput(\'5\')">5</button>' +
    '<button class="calc-btn" onclick="calcInput(\'6\')">6</button>' +
    '<button class="calc-btn op" onclick="calcOp(\'-\')">&minus;</button>' +
    '<button class="calc-btn" onclick="calcInput(\'1\')">1</button>' +
    '<button class="calc-btn" onclick="calcInput(\'2\')">2</button>' +
    '<button class="calc-btn" onclick="calcInput(\'3\')">3</button>' +
    '<button class="calc-btn op" onclick="calcOp(\'+\')">+</button>' +
    '<button class="calc-btn" onclick="calcInput(\'0\')">0</button>' +
    '<button class="calc-btn" onclick="calcInput(\'.\')">.</button>' +
    '<button class="calc-btn op" onclick="calcPercent()">%</button>' +
    '<button class="calc-btn equals" onclick="calcEquals()">=</button>' +
    '</div></div>';
    document.body.insertAdjacentHTML('beforeend', html);
  }

  // --- Initialization ---

  var staticEl = document.getElementById("static-start");
  if (staticEl) staticEl.style.display = "none";
  var appEl = document.getElementById("app");
  if (appEl) { appEl.style.display = "block"; appEl.classList.remove("hidden"); }

  document.title = CONFIG.title + (CONFIG.subtitle ? " - " + CONFIG.subtitle : "");

  initCalculator();
  render();

  // Expose functions to window for onclick handlers
  window.startTest = startTest;
  window.startFinalExam = startFinalExam;
  window.selectAnswer = selectAnswer;
  window.goPrev = goPrev;
  window.goNext = goNext;
  window.submitTest = submitTest;
  window.trySubmit = trySubmit;
  window.cancelSubmit = cancelSubmit;
  window.goHome = goHome;
  window.goAdmin = goAdmin;
  window.resumeTest = resumeTest;
  window.discardSaved = discardSaved;
  window.unlockAdmin = unlockAdmin;
  window.launchExam = launchExam;
  window.toggleCalc = toggleCalc;
  window.calcClear = calcClear;
  window.calcInput = calcInput;
  window.calcOp = calcOp;
  window.calcPercent = calcPercent;
  window.calcEquals = calcEquals;
})();
