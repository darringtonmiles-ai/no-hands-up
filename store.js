// Simple JSON-file storage. Everything lives in DATA_DIR (default ./data):
//   db.json   – classes, pupils, lessons, questions, answers, stars
//   media/    – question images and pupils' handwritten answers (PNG/JPEG)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const DB_FILE = path.join(DATA_DIR, 'db.json');

fs.mkdirSync(MEDIA_DIR, { recursive: true });

function emptyDb() {
  return {
    version: 1,
    auth: null,          // { salt, hash }
    sessions: {},        // token -> { createdAt }
    classes: {},
    students: {},
    lessons: {},
    questions: {},
    answers: {},
    sets: {},           // prepared question sets, reusable across classes
  };
}

let db = emptyDb();
if (fs.existsSync(DB_FILE)) {
  try {
    db = Object.assign(emptyDb(), JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  } catch (e) {
    console.error('Could not read db.json – starting empty. Error:', e.message);
    fs.copyFileSync(DB_FILE, DB_FILE + '.corrupt-' + Date.now());
  }
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 300);
}
function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
process.on('SIGINT', () => { flush(); process.exit(0); });
process.on('SIGTERM', () => { flush(); process.exit(0); });

const id = (n = 12) => crypto.randomBytes(n).toString('base64url');

// Save a data: URL (PNG or JPEG) to the media folder. Returns the file name.
function saveMedia(prefix, dataUrl, maxBytes) {
  const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw new Error('Image must be a PNG or JPEG');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > maxBytes) throw new Error('Image is too large');
  const name = `${prefix}_${id(16)}.${m[1] === 'png' ? 'png' : 'jpg'}`;
  fs.writeFileSync(path.join(MEDIA_DIR, name), buf);
  return name;
}

function saveMediaBuffer(prefix, buf, ext) {
  const name = `${prefix}_${id(16)}.${ext === 'png' ? 'png' : 'jpg'}`;
  fs.writeFileSync(path.join(MEDIA_DIR, name), buf);
  return name;
}

function mediaPath(name) {
  if (!/^[aq]_[A-Za-z0-9_-]+\.(png|jpg)$/.test(name || '')) return null;
  const p = path.join(MEDIA_DIR, name);
  return fs.existsSync(p) ? p : null;
}

function removeMedia(name) {
  const p = mediaPath(name);
  if (p) fs.unlink(p, () => {});
}

// Backup = db.json with every media file embedded, so one file restores everything.
function exportBackup() {
  flush();
  const media = {};
  for (const f of fs.readdirSync(MEDIA_DIR)) {
    if (mediaPath(f)) media[f] = fs.readFileSync(path.join(MEDIA_DIR, f)).toString('base64');
  }
  const copy = JSON.parse(JSON.stringify(db));
  copy.sessions = {};
  return JSON.stringify({ app: 'hands-up', exportedAt: Date.now(), db: copy, media });
}

function importBackup(json) {
  const data = JSON.parse(json);
  if (data.app !== 'hands-up' || !data.db) throw new Error('This is not a Hands Up backup file');
  for (const [f, b64] of Object.entries(data.media || {})) {
    if (/^[aq]_[A-Za-z0-9_-]+\.(png|jpg)$/.test(f)) fs.writeFileSync(path.join(MEDIA_DIR, f), Buffer.from(b64, 'base64'));
  }
  const keepAuth = db.auth;
  const keepSessions = db.sessions;
  db = Object.assign(emptyDb(), data.db);
  db.auth = keepAuth || db.auth;   // keep the current password
  db.sessions = keepSessions;
  flush();
}

module.exports = {
  get db() { return db; },
  save, flush, id, saveMedia, saveMediaBuffer, mediaPath, removeMedia, exportBackup, importBackup, DATA_DIR,
};
