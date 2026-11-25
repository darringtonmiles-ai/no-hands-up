// Hands Up – live class answers.  Run with:  npm start
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const store = require('./store');
const { lessonPdf } = require('./pdf');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 4e6 });

app.set('trust proxy', 1);
app.use(express.json({ limit: '12mb' }));

// ---------- helpers ----------
const db = () => store.db;
const now = () => Date.now();
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim().slice(0, max);
const nameKey = (s) => clean(s, 40).toLowerCase().replace(/\s+/g, ' ');

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setCookie(res, name, value, maxAgeDays) {
  const secure = process.env.NODE_ENV === 'production' || process.env.SECURE_COOKIES === '1';
  res.append('Set-Cookie',
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeDays * 86400}${secure ? '; Secure' : ''}`);
}
function hashPassword(pw, salt) {
  return crypto.scryptSync(pw, salt, 32).toString('hex');
}
function isTeacher(cookieHeader) {
  const t = parseCookies(cookieHeader).hu_teacher;
  return !!(t && db().sessions[t]);
}
function studentFrom(cookieHeader) {
  const t = parseCookies(cookieHeader).hu_pupil;
  if (!t) return null;
  return Object.values(db().students).find((s) => s.token === t && !s.removed) || null;
}
const requireTeacher = (req, res, next) =>
  isTeacher(req.headers.cookie) ? next() : res.status(401).json({ error: 'Sign in as the teacher first' });

const JOIN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newJoinCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += JOIN_ALPHABET[crypto.randomInt(JOIN_ALPHABET.length)];
    if (!Object.values(db().classes).some((k) => k.code === c)) return c;
  }
}

function liveOf(cls) {
  if (!cls.live) cls.live = { lessonId: null, questionId: null, board: { view: 'join', answerIds: [], showNames: false, range: 'today' } };
  if (!cls.live.hands) cls.live.hands = {};        // studentId -> time the hand went up
  if (cls.live.locked == null) cls.live.locked = false;
  if (!cls.settings) cls.settings = { helpHand: false };
  return cls.live;
}
const classQuestions = (lessonId) =>
  Object.values(db().questions).filter((q) => q.lessonId === lessonId).sort((a, b) => a.createdAt - b.createdAt);
const answersFor = (questionId) =>
  Object.values(db().answers).filter((a) => a.questionId === questionId);

// ---------- online pupils ----------
const online = new Map(); // studentId -> socket count
const isOnline = (sid) => (online.get(sid) || 0) > 0;

// ---------- snapshots ----------
function teacherSnapshot(classId) {
  const cls = db().classes[classId];
  if (!cls) return null;
  const live = liveOf(cls);
  const q = live.questionId ? db().questions[live.questionId] : null;
  const lesson = live.lessonId ? db().lessons[live.lessonId] : null;
  const students = Object.values(db().students)
    .filter((s) => s.classId === classId && !s.removed)
    .map((s) => ({ id: s.id, name: s.name, online: isOnline(s.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const answers = q ? answersFor(q.id).map(publicAnswer).sort((a, b) => a.submittedAt - b.submittedAt) : [];
  const spotlight = (live.board.answerIds || [])
    .map((aid) => db().answers[aid]).filter(Boolean).map(publicAnswer);
  const askedItemIds = lesson && !lesson.endedAt ? classQuestions(lesson.id).map((x) => x.sourceItemId).filter(Boolean) : [];
  return {
    class: { id: cls.id, name: cls.name, code: cls.code },
    settings: cls.settings,
    locked: live.locked,
    hands: cls.settings.helpHand ? live.hands : {},
    askedItemIds,
    board: live.board,
    lesson: lesson && { id: lesson.id, title: lesson.title, startedAt: lesson.startedAt, endedAt: lesson.endedAt,
      questionCount: classQuestions(lesson.id).length },
    question: q,
    answers,
    tally: q && q.mode === 'choice' ? tallyFor(q) : null,
    spotlight,
    students,
  };
}
function publicAnswer(a) {
  const s = db().students[a.studentId];
  return { id: a.id, questionId: a.questionId, studentId: a.studentId, name: s ? s.name : 'Removed pupil',
    text: a.text, drawing: a.drawing, choice: a.choice, submittedAt: a.submittedAt, edits: a.edits || 0, starred: !!a.starred,
    feedback: a.feedback || '' };
}
function tallyFor(q) {
  const counts = q.options.map(() => 0);
  for (const a of answersFor(q.id)) if (a.choice != null && counts[a.choice] != null) counts[a.choice]++;
  return counts;
}
function pupilQuestion(q) {
  if (!q) return null;
  return { id: q.id, text: q.text, mode: q.mode, options: q.options, image: q.image, closed: q.closed,
    revealed: !!q.revealed, correct: q.revealed ? q.correct : null };
}
function pupilState(student) {
  const cls = db().classes[student.classId];
  const live = liveOf(cls);
  const lesson = live.lessonId ? db().lessons[live.lessonId] : null;
  const q = live.questionId ? db().questions[live.questionId] : null;
  const mine = q ? answersFor(q.id).find((a) => a.studentId === student.id) : null;
  return {
    student: { id: student.id, name: student.name },
    class: { name: cls.name },
    lesson: lesson && { id: lesson.id, title: lesson.title, ended: !!lesson.endedAt },
    question: lesson && !lesson.endedAt ? pupilQuestion(q) : null,
    myAnswer: mine && { text: mine.text, drawing: mine.drawing, choice: mine.choice, starred: !!mine.starred, feedback: mine.feedback || '' },
    locked: !!live.locked && !!lesson && !lesson.endedAt,
    helpHand: !!cls.settings.helpHand && !!lesson && !lesson.endedAt,
    handUp: !!(cls.settings.helpHand && live.hands[student.id]),
  };
}

const pending = new Map();
function broadcast(classId) {
  if (pending.has(classId)) return;
  pending.set(classId, setTimeout(async () => {
    pending.delete(classId);
    io.to('t:' + classId).emit('snapshot', teacherSnapshot(classId));
    const sockets = await io.in('p:' + classId).fetchSockets();
    for (const s of sockets) {
      const st = db().students[s.data.studentId];
      if (st && !st.removed) s.emit('state', pupilState(st));
    }
  }, 40));
}

// ---------- teacher auth ----------
app.get('/api/auth', (req, res) => {
  res.json({ setup: !!db().auth, authed: isTeacher(req.headers.cookie) });
});
app.post('/api/setup', (req, res) => {
  if (db().auth) return res.status(400).json({ error: 'A teacher password is already set' });
  const pw = String(req.body.password || '');
  if (pw.length < 8) return res.status(400).json({ error: 'Use at least 8 characters' });
  const salt = store.id(16);
  db().auth = { salt, hash: hashPassword(pw, salt) };
  const token = store.id(24);
  db().sessions[token] = { createdAt: now() };
  store.save();
  setCookie(res, 'hu_teacher', token, 60);
  res.json({ ok: true });
});
const loginAttempts = new Map();
app.post('/api/login', (req, res) => {
  const ip = req.ip;
  const att = loginAttempts.get(ip) || { n: 0, t: now() };
  if (now() - att.t > 15 * 60e3) { att.n = 0; att.t = now(); }
  if (att.n >= 10) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes' });
  const a = db().auth;
  if (!a) return res.status(400).json({ error: 'Set a password first' });
  const ok = crypto.timingSafeEqual(Buffer.from(hashPassword(String(req.body.password || ''), a.salt), 'hex'), Buffer.from(a.hash, 'hex'));
  if (!ok) { att.n++; loginAttempts.set(ip, att); return res.status(401).json({ error: 'That password is not right' }); }
  loginAttempts.delete(ip);
  const token = store.id(24);
  db().sessions[token] = { createdAt: now() };
  store.save();
  setCookie(res, 'hu_teacher', token, 60);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => {
  const t = parseCookies(req.headers.cookie).hu_teacher;
  if (t) { delete db().sessions[t]; store.save(); }
  setCookie(res, 'hu_teacher', '', 0);
  res.json({ ok: true });
});
app.post('/api/password', requireTeacher, (req, res) => {
  const a = db().auth;
  if (hashPassword(String(req.body.current || ''), a.salt) !== a.hash) return res.status(401).json({ error: 'Current password is not right' });
  const pw = String(req.body.password || '');
  if (pw.length < 8) return res.status(400).json({ error: 'Use at least 8 characters' });
  a.salt = store.id(16); a.hash = hashPassword(pw, a.salt);
  store.save();
  res.json({ ok: true });
});

// ---------- classes ----------
function classSummary(c) {
  const pupils = Object.values(db().students).filter((s) => s.classId === c.id && !s.removed).length;
  const lessons = Object.values(db().lessons).filter((l) => l.classId === c.id).length;
  return { id: c.id, name: c.name, code: c.code, archived: !!c.archived, createdAt: c.createdAt, pupils, lessons };
}
app.get('/api/classes', requireTeacher, (req, res) => {
  res.json(Object.values(db().classes).sort((a, b) => a.createdAt - b.createdAt).map(classSummary));
});
app.post('/api/classes', requireTeacher, (req, res) => {
  const name = clean(req.body.name, 60);
  if (!name) return res.status(400).json({ error: 'Give the class a name' });
  const c = { id: store.id(), name, code: newJoinCode(), createdAt: now(), archived: false };
  liveOf(c);
  db().classes[c.id] = c;
  store.save();
  res.json(classSummary(c));
});
app.patch('/api/classes/:id', requireTeacher, (req, res) => {
  const c = db().classes[req.params.id];
  if (!c) return res.status(404).json({ error: 'Class not found' });
  if (req.body.name != null) c.name = clean(req.body.name, 60) || c.name;
  if (req.body.archived != null) c.archived = !!req.body.archived;
  if (req.body.newCode) c.code = newJoinCode();
  store.save();
  broadcast(c.id);
  res.json(classSummary(c));
});

// Leaderboard: stars (highlighted answers) per pupil since a time.
app.get('/api/classes/:id/leaderboard', requireTeacher, (req, res) => {
  const c = db().classes[req.params.id];
  if (!c) return res.status(404).json({ error: 'Class not found' });
  res.json(leaderboard(c.id, Number(req.query.since) || 0));
});
function leaderboard(classId, since) {
  const rows = new Map();
  for (const s of Object.values(db().students)) {
    if (s.classId === classId && !s.removed) rows.set(s.id, { id: s.id, name: s.name, stars: 0, answers: 0, lastStar: 0 });
  }
  for (const a of Object.values(db().answers)) {
    const r = rows.get(a.studentId);
    if (!r || a.classId !== classId) continue;
    if (a.submittedAt >= since) r.answers++;
    if (a.starred && a.starredAt >= since) { r.stars++; r.lastStar = Math.max(r.lastStar, a.starredAt); }
  }
  return [...rows.values()].sort((a, b) => b.stars - a.stars || b.answers - a.answers || a.name.localeCompare(b.name));
}

// Lessons list + records
app.get('/api/classes/:id/lessons', requireTeacher, (req, res) => {
  const list = Object.values(db().lessons).filter((l) => l.classId === req.params.id)
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((l) => {
      const qs = classQuestions(l.id);
      const ans = qs.reduce((n, q) => n + answersFor(q.id).length, 0);
      const stars = qs.reduce((n, q) => n + answersFor(q.id).filter((a) => a.starred).length, 0);
      return { id: l.id, title: l.title, startedAt: l.startedAt, endedAt: l.endedAt, questions: qs.length, answers: ans, stars };
    });
  res.json(list);
});
app.get('/api/lessons/:id/record.pdf', requireTeacher, (req, res) => {
  const lesson = db().lessons[req.params.id];
  if (!lesson) return res.status(404).send('Lesson not found');
  sendPdf(res, lesson, null);
});

// Pupils
app.get('/api/classes/:id/pupils', requireTeacher, (req, res) => {
  res.json(leaderboard(req.params.id, 0).map((r) => ({ ...r, online: isOnline(r.id) })));
});
app.patch('/api/pupils/:id', requireTeacher, (req, res) => {
  const s = db().students[req.params.id];
  if (!s) return res.status(404).json({ error: 'Pupil not found' });
  if (req.body.name != null) {
    const n = clean(req.body.name, 40);
    if (n) { s.name = n; s.nameKey = nameKey(n); }
  }
  store.save();
  broadcast(s.classId);
  res.json({ ok: true });
});
// Remove a pupil and permanently delete everything they have written (answers, drawings, stars).
app.delete('/api/pupils/:id', requireTeacher, (req, res) => {
  const s = db().students[req.params.id];
  if (!s) return res.status(404).json({ error: 'Pupil not found' });
  let deleted = 0;
  for (const a of Object.values(db().answers)) {
    if (a.studentId !== s.id) continue;
    if (a.drawing) store.removeMedia(a.drawing);
    delete db().answers[a.id];
    deleted++;
  }
  const cls = db().classes[s.classId];
  if (cls) {
    const live = liveOf(cls);
    delete live.hands[s.id];
    live.board.answerIds = (live.board.answerIds || []).filter((x) => db().answers[x]);
  }
  for (const sock of io.sockets.sockets.values()) if (sock.data.studentId === s.id) { sock.emit('removed'); sock.disconnect(true); }
  delete db().students[s.id];
  store.save();
  broadcast(s.classId);
  res.json({ ok: true, deletedAnswers: deleted });
});

// Question images
app.post('/api/upload', requireTeacher, (req, res) => {
  try { res.json({ file: store.saveMedia('q', req.body.dataUrl, 8e6) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- question sets (prepared before the lesson, reusable across classes) ----------
// Drops blank options and keeps "correct" pointing at the same option.
function cleanOptions(raw, correctIdx, keepBlanks) {
  const list = (Array.isArray(raw) ? raw : []).slice(0, 6).map((o, i) => ({ o: clean(o, 200), i }));
  const kept = keepBlanks ? list : list.filter((x) => x.o);
  const pos = kept.findIndex((x) => x.i === correctIdx);
  return { options: kept.map((x) => x.o), correct: Number.isInteger(correctIdx) && pos >= 0 ? pos : null };
}
function cleanItem(it) {
  const mode = ['text', 'draw', 'either', 'choice'].includes(it.mode) ? it.mode : 'either';
  // Sets are edited live, so blank options are kept here and dropped when the question is asked.
  const { options, correct } = mode === 'choice' ? cleanOptions(it.options, it.correct, true) : { options: [], correct: null };
  const image = it.image && String(it.image).startsWith('q_') && store.mediaPath(it.image) ? it.image : null;
  return { id: /^[\w-]{6,30}$/.test(it.id || '') ? it.id : store.id(), text: clean(it.text, 1000), mode, options, correct, image };
}
app.get('/api/sets', requireTeacher, (req, res) => {
  res.json(Object.values(db().sets).sort((a, b) => b.updatedAt - a.updatedAt));
});
app.post('/api/sets', requireTeacher, (req, res) => {
  const set = { id: store.id(), title: clean(req.body.title, 100) || 'Untitled set', createdAt: now(), updatedAt: now(),
    items: (Array.isArray(req.body.items) ? req.body.items : []).slice(0, 200).map(cleanItem) };
  db().sets[set.id] = set;
  store.save();
  res.json(set);
});
app.put('/api/sets/:id', requireTeacher, (req, res) => {
  const set = db().sets[req.params.id];
  if (!set) return res.status(404).json({ error: 'Set not found' });
  if (req.body.title != null) set.title = clean(req.body.title, 100) || set.title;
  if (Array.isArray(req.body.items)) set.items = req.body.items.slice(0, 200).map(cleanItem);
  set.updatedAt = now();
  store.save();
  res.json(set);
});
app.delete('/api/sets/:id', requireTeacher, (req, res) => {
  delete db().sets[req.params.id];
  store.save();
  res.json({ ok: true });
});
// PowerPoint import: returns each slide's text and first picture so the teacher can pick questions.
app.post('/api/import-pptx', requireTeacher, express.raw({ limit: '80mb', type: '*/*' }), (req, res) => {
  try { res.json(require('./pptx').readSlides(req.body, (buf, ext) => store.saveMediaBuffer('q', buf, ext))); }
  catch (e) { res.status(400).json({ error: e.message || 'Could not read that PowerPoint' }); }
});

// Media: question images are visible to everyone in the class; handwritten answers
// only to the teacher and the pupil who wrote them.
app.get('/media/:file', (req, res) => {
  const f = req.params.file;
  const p = store.mediaPath(f);
  if (!p) return res.status(404).end();
  if (f.startsWith('a_') && !isTeacher(req.headers.cookie)) {
    const st = studentFrom(req.headers.cookie);
    const own = st && Object.values(db().answers).some((a) => a.drawing === f && a.studentId === st.id);
    if (!own) return res.status(403).end();
  }
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(p);
});

// Backup / restore
app.get('/api/backup', requireTeacher, (req, res) => {
  const d = new Date().toISOString().slice(0, 10);
  res.set('Content-Type', 'application/json');
  res.set('Content-Disposition', `attachment; filename="hands-up-backup-${d}.json"`);
  res.send(store.exportBackup());
});
app.post('/api/restore', requireTeacher, express.text({ limit: '500mb', type: '*/*' }), (req, res) => {
  try {
    store.importBackup(req.body);
    for (const c of Object.values(db().classes)) broadcast(c.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- pupils ----------
app.post('/api/join', (req, res) => {
  const code = clean(req.body.code, 10).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const name = clean(req.body.name, 40);
  const cls = Object.values(db().classes).find((c) => c.code === code && !c.archived);
  if (!cls) return res.status(404).json({ error: 'No class has that code. Check the code on the board' });
  if (name.length < 2) return res.status(400).json({ error: 'Type your name (at least 2 letters)' });
  const key = nameKey(name);
  let s = Object.values(db().students).find((x) => x.classId === cls.id && x.nameKey === key && !x.removed);
  if (!s) {
    s = { id: store.id(), classId: cls.id, name, nameKey: key, token: store.id(24), createdAt: now() };
    db().students[s.id] = s;
    store.save();
  }
  setCookie(res, 'hu_pupil', s.token, 365);
  broadcast(cls.id);
  res.json({ ok: true, name: s.name, className: cls.name });
});
app.get('/api/me', (req, res) => {
  const s = studentFrom(req.headers.cookie);
  if (!s) return res.json({ joined: false });
  const cls = db().classes[s.classId];
  res.json({ joined: true, name: s.name, className: cls.name, code: cls.code });
});
app.post('/api/leave', (req, res) => {
  setCookie(res, 'hu_pupil', '', 0);
  res.json({ ok: true });
});
// The pupil's own lessons (any lesson in their class since they joined, or that they answered in).
app.get('/api/me/lessons', (req, res) => {
  const s = studentFrom(req.headers.cookie);
  if (!s) return res.status(401).json({ error: 'Join your class first' });
  const list = Object.values(db().lessons).filter((l) => l.classId === s.classId)
    .map((l) => {
      const qs = classQuestions(l.id);
      const mine = qs.map((q) => answersFor(q.id).find((a) => a.studentId === s.id)).filter(Boolean);
      return { id: l.id, title: l.title, startedAt: l.startedAt, endedAt: l.endedAt, questions: qs.length,
        answered: mine.length, stars: mine.filter((a) => a.starred).length, attended: mine.length > 0 || (l.endedAt || now()) >= s.createdAt };
    })
    .filter((l) => l.attended && l.questions > 0)
    .sort((a, b) => b.startedAt - a.startedAt);
  res.json(list);
});
app.get('/api/me/lessons/:id/notes.pdf', (req, res) => {
  const s = studentFrom(req.headers.cookie);
  if (!s) return res.status(401).send('Join your class first');
  const lesson = db().lessons[req.params.id];
  if (!lesson || lesson.classId !== s.classId) return res.status(404).send('Lesson not found');
  sendPdf(res, lesson, s);
});

function sendPdf(res, lesson, student) {
  const cls = db().classes[lesson.classId];
  const questions = classQuestions(lesson.id).map((q) => ({
    ...q,
    answers: answersFor(q.id).map(publicAnswer).sort((a, b) => a.submittedAt - b.submittedAt),
    tally: q.mode === 'choice' ? tallyFor(q) : null,
  }));
  const d = new Date(lesson.startedAt).toISOString().slice(0, 10);
  const who = student ? student.name.replace(/[^\w-]+/g, '-') : 'class-record';
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${cls.name.replace(/[^\w-]+/g, '-')}-${d}-${who}.pdf"`);
  lessonPdf(res, { className: cls.name, lesson, questions, student, mediaPath: store.mediaPath });
}

// ---------- sockets ----------
io.on('connection', (socket) => {
  const cookie = socket.handshake.headers.cookie;
  const teacher = isTeacher(cookie);

  // Pupil connection
  const st = studentFrom(cookie);
  if (st && socket.handshake.auth.role === 'pupil') {
    socket.data.studentId = st.id;
    socket.join('p:' + st.classId);
    online.set(st.id, (online.get(st.id) || 0) + 1);
    socket.emit('state', pupilState(st));
    broadcast(st.classId);
    socket.on('disconnect', () => {
      online.set(st.id, Math.max(0, (online.get(st.id) || 1) - 1));
      broadcast(st.classId);
    });

    socket.on('hand', (up, ack = () => {}) => {
      const s = db().students[st.id];
      const cls = s && db().classes[s.classId];
      if (!cls) return ack({ error: 'Join your class first' });
      const live = liveOf(cls);
      if (!cls.settings.helpHand) return ack({ error: 'Your teacher has not turned this on' });
      if (up) live.hands[s.id] = now(); else delete live.hands[s.id];
      store.save();
      broadcast(cls.id);
      ack({ ok: true });
    });

    socket.on('answer', (msg, ack = () => {}) => {
      const s = db().students[st.id];
      if (!s || s.removed) return ack({ error: 'You have been removed from this class' });
      const cls = db().classes[s.classId];
      const live = liveOf(cls);
      if (live.locked) return ack({ error: 'Pens down. Your teacher has paused answers' });
      const q = db().questions[msg && msg.questionId];
      if (!q || q.id !== live.questionId) return ack({ error: 'That question has finished' });
      if (q.closed) return ack({ error: 'Your teacher has closed answers for this question' });
      let a = answersFor(q.id).find((x) => x.studentId === s.id);
      const isNew = !a;
      if (!a) a = { id: store.id(), questionId: q.id, lessonId: q.lessonId, classId: cls.id, studentId: s.id, text: '', drawing: null, choice: null, edits: 0 };
      try {
        if (q.mode === 'choice') {
          const c = Number(msg.choice);
          if (!Number.isInteger(c) || c < 0 || c >= q.options.length) return ack({ error: 'Pick one of the options' });
          a.choice = c;
        } else {
          const text = clean(msg.text, 2000);
          let drawing = a.drawing;
          if (msg.drawing) {
            if (q.mode === 'text') return ack({ error: 'This question is typed answers only' });
            const file = store.saveMedia('a', msg.drawing, 3e6);
            if (a.drawing) store.removeMedia(a.drawing);
            drawing = file;
          } else if (msg.clearDrawing && a.drawing) {
            store.removeMedia(a.drawing); drawing = null;
          }
          if (q.mode === 'draw' && text && !drawing) return ack({ error: 'This question needs a handwritten answer' });
          if (!text && !drawing) return ack({ error: 'Your answer is empty' });
          a.text = q.mode === 'draw' ? '' : text;
          a.drawing = drawing;
        }
      } catch (e) { return ack({ error: e.message }); }
      if (!isNew) a.edits = (a.edits || 0) + 1;
      a.submittedAt = now();
      db().answers[a.id] = a;
      store.save();
      broadcast(cls.id);
      ack({ ok: true });
    });
    return;
  }

  if (!teacher || socket.handshake.auth.role !== 'teacher') {
    socket.emit('auth-required');
    return;
  }

  // Teacher / board connection
  let classId = null;
  const own = (cid) => cid && db().classes[cid];
  const touch = (cid) => { store.save(); broadcast(cid); };

  socket.on('watch', (cid, ack = () => {}) => {
    if (!own(cid)) return ack({ error: 'Class not found' });
    if (classId) socket.leave('t:' + classId);
    classId = cid;
    socket.join('t:' + cid);
    ack({ ok: true, snapshot: teacherSnapshot(cid) });
  });

  function currentLesson(cls) {
    const live = liveOf(cls);
    let l = live.lessonId && db().lessons[live.lessonId];
    if (!l || l.endedAt) {
      l = { id: store.id(), classId: cls.id, title: '', startedAt: now(), endedAt: null };
      db().lessons[l.id] = l;
      live.lessonId = l.id;
    }
    return l;
  }

  socket.on('question:post', (m, ack = () => {}) => {
    const cls = own(classId);
    if (!cls) return ack({ error: 'Open a class first' });
    const mode = ['text', 'draw', 'either', 'choice'].includes(m.mode) ? m.mode : 'either';
    const text = clean(m.text, 1000);
    let options = [];
    let correct = null;
    if (mode === 'choice') {
      ({ options, correct } = cleanOptions(m.options, m.correct));
      if (options.length < 2) return ack({ error: 'Add at least two options' });
    }
    const image = m.image && store.mediaPath(m.image) && m.image.startsWith('q_') ? m.image : null;
    // A question with no text is fine: pupils are told to answer the question on the board.
    const lesson = currentLesson(cls);
    const live = liveOf(cls);
    if (live.questionId && db().questions[live.questionId]) db().questions[live.questionId].closed = true;
    const sourceItemId = typeof m.sourceItemId === 'string' ? m.sourceItemId.slice(0, 30) : null;
    const q = { id: store.id(), classId: cls.id, lessonId: lesson.id, text, mode, options, correct, revealed: false, image,
      createdAt: now(), closed: false, sourceItemId };
    db().questions[q.id] = q;
    live.questionId = q.id;
    live.board = { ...live.board, view: 'question', answerIds: [] };
    touch(cls.id);
    ack({ ok: true });
  });

  socket.on('question:close', (closed, ack = () => {}) => {
    const cls = own(classId);
    const q = cls && db().questions[liveOf(cls).questionId];
    if (!q) return ack({ error: 'No question is live' });
    q.closed = !!closed;
    touch(cls.id);
    ack({ ok: true });
  });

  socket.on('choice:reveal', (revealed, ack = () => {}) => {
    const cls = own(classId);
    const q = cls && db().questions[liveOf(cls).questionId];
    if (!q || q.mode !== 'choice') return ack({ error: 'No multiple-choice question is live' });
    if (q.correct == null && revealed) return ack({ error: 'Mark the correct option first' });
    q.revealed = !!revealed;
    if (revealed) q.closed = true;
    touch(cls.id);
    ack({ ok: true });
  });

  socket.on('choice:correct', (idx, ack = () => {}) => {
    const cls = own(classId);
    const q = cls && db().questions[liveOf(cls).questionId];
    if (!q || q.mode !== 'choice' || !Number.isInteger(idx) || idx < 0 || idx >= q.options.length) return ack({ error: 'Not possible' });
    q.correct = idx;
    touch(cls.id);
    ack({ ok: true });
  });

  socket.on('answer:star', (m, ack = () => {}) => {
    const a = db().answers[m && m.answerId];
    if (!a || !own(a.classId)) return ack({ error: 'Answer not found' });
    a.starred = !!m.starred;
    a.starredAt = a.starred ? now() : null;
    touch(a.classId);
    ack({ ok: true });
  });

  socket.on('board:set', (m, ack = () => {}) => {
    const cls = own(classId);
    if (!cls) return ack({ error: 'Open a class first' });
    const live = liveOf(cls);
    const b = { ...live.board };
    if (['join', 'question', 'results', 'spotlight', 'leaderboard', 'blank'].includes(m.view)) b.view = m.view;
    if (Array.isArray(m.answerIds)) b.answerIds = m.answerIds.filter((x) => db().answers[x] && db().answers[x].classId === cls.id).slice(0, 12);
    if (m.showNames != null) b.showNames = !!m.showNames;
    if (['today', '7', '30', 'all'].includes(m.range)) b.range = m.range;
    if (m.since != null) b.since = Number(m.since) || 0;
    live.board = b;
    touch(cls.id);
    ack({ ok: true });
  });

  socket.on('answer:feedback', (m, ack = () => {}) => {
    const a = db().answers[m && m.answerId];
    if (!a || !own(a.classId)) return ack({ error: 'Answer not found' });
    a.feedback = clean(m.text, 300);
    a.feedbackAt = a.feedback ? now() : null;
    touch(a.classId);
    ack({ ok: true });
  });

  socket.on('pens', (locked, ack = () => {}) => {
    const cls = own(classId);
    if (!cls) return ack({ error: 'Open a class first' });
    liveOf(cls).locked = !!locked;
    touch(cls.id);
    ack({ ok: true });
  });

  socket.on('settings', (m, ack = () => {}) => {
    const cls = own(classId);
    if (!cls) return ack({ error: 'Open a class first' });
    liveOf(cls);
    if (m.helpHand != null) {
      cls.settings.helpHand = !!m.helpHand;
      if (!cls.settings.helpHand) cls.live.hands = {};
    }
    touch(cls.id);
    ack({ ok: true });
  });

  socket.on('hand:lower', (studentId, ack = () => {}) => {
    const cls = own(classId);
    if (!cls) return ack({ error: 'Open a class first' });
    if (studentId === '*') cls.live.hands = {}; else delete liveOf(cls).hands[studentId];
    touch(cls.id);
    ack({ ok: true });
  });

  socket.on('leaderboard', (since, ack = () => {}) => {
    if (!own(classId)) return ack({ error: 'Open a class first' });
    ack({ ok: true, rows: leaderboard(classId, Number(since) || 0) });
  });

  socket.on('lesson:title', (title, ack = () => {}) => {
    const cls = own(classId);
    const l = cls && db().lessons[liveOf(cls).lessonId];
    if (!l) return ack({ error: 'No lesson yet' });
    l.title = clean(title, 100);
    touch(cls.id);
    ack({ ok: true });
  });

  socket.on('lesson:end', (_, ack = () => {}) => {
    const cls = own(classId);
    const live = cls && liveOf(cls);
    const l = live && db().lessons[live.lessonId];
    if (!l || l.endedAt) return ack({ error: 'No lesson is running' });
    l.endedAt = now();
    const q = db().questions[live.questionId];
    if (q) q.closed = true;
    live.questionId = null;
    live.locked = false;
    live.hands = {};
    live.board = { ...live.board, view: 'join', answerIds: [] };
    touch(cls.id);
    io.to('p:' + cls.id).emit('lessonEnded', { lessonId: l.id });
    ack({ ok: true, lessonId: l.id });
  });
});

// ---------- pages ----------
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/healthz', (req, res) => res.send('ok'));

server.listen(PORT, () => {
  console.log(`Hands Up is running on http://localhost:${PORT}`);
  console.log(`  Pupils:  http://localhost:${PORT}/`);
  console.log(`  Teacher: http://localhost:${PORT}/teacher`);
  console.log(`  Data is stored in ${store.DATA_DIR}`);
});
