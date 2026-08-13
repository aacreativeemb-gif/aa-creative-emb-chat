// Lightweight JSON-file based store — no external database needed.
// Good for small/medium traffic. For higher scale, swap this for a real DB
// (Postgres/MySQL/SQLite) while keeping the same function signatures.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    return { visitors: {}, messages: {}, settings: {} };
  }
  try {
    const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    if (!db.settings) db.settings = {};
    return db;
  } catch (e) {
    return { visitors: {}, messages: {}, settings: {} };
  }
}

function saveDB(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// Create or update a visitor record. Called on every session check-in.
function upsertVisitor(id, fields) {
  const db = loadDB();
  const now = new Date().toISOString();
  const existing = db.visitors[id];

  if (existing) {
    if (fields.name) existing.name = fields.name;
    if (fields.email) existing.email = fields.email;
    if (fields.ip) existing.ip = fields.ip;
    if (fields.country) existing.country = fields.country;
    if (fields.countryCode) existing.countryCode = fields.countryCode;
    if (fields.city) existing.city = fields.city;
    existing.lastSeenAt = now;
    if (fields.isNewVisit) existing.visitCount = (existing.visitCount || 1) + 1;
    if (typeof fields.needsHuman === 'boolean') existing.needsHuman = fields.needsHuman;
  } else {
    db.visitors[id] = {
      id,
      name: fields.name || '',
      email: fields.email || '',
      ip: fields.ip || '',
      country: fields.country || 'Unknown',
      countryCode: fields.countryCode || '',
      city: fields.city || '',
      needsHuman: false,
      firstSeenAt: now,
      lastSeenAt: now,
      visitCount: 1
    };
    db.messages[id] = [];
  }

  saveDB(db);
  return db.visitors[id];
}

function setNeedsHuman(id, value) {
  const db = loadDB();
  if (!db.visitors[id]) return null;
  db.visitors[id].needsHuman = value;
  saveDB(db);
  return db.visitors[id];
}

// Admin-editable overrides for the AI's system prompt / knowledge base.
// If not set, the server falls back to the .md files on disk.
function getSettings() {
  const db = loadDB();
  return db.settings || {};
}

function updateSettings(fields) {
  const db = loadDB();
  db.settings = { ...(db.settings || {}), ...fields };
  saveDB(db);
  return db.settings;
}

function getVisitor(id) {
  const db = loadDB();
  return db.visitors[id] || null;
}

function addMessage(visitorId, role, content) {
  const db = loadDB();
  if (!db.messages[visitorId]) db.messages[visitorId] = [];
  db.messages[visitorId].push({ role, content, at: new Date().toISOString() });
  saveDB(db);
}

function getMessages(visitorId) {
  const db = loadDB();
  return db.messages[visitorId] || [];
}

function listVisitors() {
  const db = loadDB();
  return Object.values(db.visitors).sort(
    (a, b) => new Date(b.lastSeenAt) - new Date(a.lastSeenAt)
  );
}

module.exports = { upsertVisitor, getVisitor, addMessage, getMessages, listVisitors, setNeedsHuman, getSettings, updateSettings };
