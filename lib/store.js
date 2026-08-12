// Lightweight JSON-file based store — no external database needed.
// Good for small/medium traffic. For higher scale, swap this for a real DB
// (Postgres/MySQL/SQLite) while keeping the same function signatures.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    return { visitors: {}, messages: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    return { visitors: {}, messages: {} };
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
  } else {
    db.visitors[id] = {
      id,
      name: fields.name || '',
      email: fields.email || '',
      ip: fields.ip || '',
      country: fields.country || 'Unknown',
      countryCode: fields.countryCode || '',
      city: fields.city || '',
      firstSeenAt: now,
      lastSeenAt: now,
      visitCount: 1
    };
    db.messages[id] = [];
  }

  saveDB(db);
  return db.visitors[id];
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

module.exports = { upsertVisitor, getVisitor, addMessage, getMessages, listVisitors };
