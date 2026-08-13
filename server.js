require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const sharedSession = require('express-socket.io-session');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const store = require('./lib/store');
const { getGeoInfo, getClientIp } = require('./lib/geo');

const app = express();
app.set('trust proxy', true); // needed so req IP is correct behind Render/Vercel/etc. proxies

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret';

// When the chat widget is embedded in an iframe on a different domain
// (e.g. aacreativeemb.com embeds a widget hosted on chat.aacreativeemb.com),
// the visitor cookie must be SameSite=None + Secure to survive that
// cross-site context — which only works over HTTPS. Locally (http) we fall
// back to Lax so testing on localhost still works.
const IS_PROD = process.env.NODE_ENV === 'production';

app.use(express.json());
app.use(cookieParser());

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 8 } // 8 hour admin session
});
app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Realtime (WebSocket) ----------
// Replaces the old polling loops: the customer widget joins a room for its
// own visitor ID, and the admin dashboard joins an 'admin' room. Whenever a
// message is added or a visitor record changes, we push a small event —
// clients then re-fetch just the data they need (kept simple and safe
// against duplicate/out-of-order messages).
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: true, credentials: true } });
io.use(sharedSession(sessionMiddleware, { autoSave: true }));

io.on('connection', (socket) => {
  const { visitorId } = socket.handshake.auth || {};
  const isAdmin = socket.handshake.session && socket.handshake.session.isAdmin;

  if (isAdmin) {
    socket.join('admin');
  } else if (visitorId && store.getVisitor(visitorId)) {
    socket.join(`visitor:${visitorId}`);
  }
});

function notifyNewMessage(visitorId) {
  io.to(`visitor:${visitorId}`).emit('messages-changed');
  io.to('admin').emit('messages-changed', { visitorId });
}

function notifyVisitorsChanged() {
  io.to('admin').emit('visitors-changed');
}

function loadFile(filename, fallback) {
  try {
    return fs.readFileSync(path.join(__dirname, filename), 'utf8');
  } catch (e) {
    return fallback;
  }
}

// Simple keyword check to flag when a customer is asking for a real person.
// Covers common English and Roman Urdu/Hindi phrasings.
const HUMAN_REQUEST_PATTERNS = [
  'human', 'real person', 'live agent', 'talk to someone', 'talk to a person',
  'talk to a human', 'speak to someone', 'speak to a human', 'customer service rep',
  'representative', 'agent se baat', 'insaan se baat', 'admin se baat', 'banda se baat',
  'kisi insan', 'live chat', 'connect me to', 'talk to your team'
];
function isHumanRequest(text) {
  const lower = text.toLowerCase();
  return HUMAN_REQUEST_PATTERNS.some(p => lower.includes(p));
}

// ---------- Visitor session (customer side) ----------

const VISITOR_COOKIE = 'aace_visitor_id';

// Called on page load: creates or recognizes a visitor, runs geo lookup,
// and returns their info + any prior chat history so the widget can resume.
app.post('/api/session', async (req, res) => {
  try {
    const { name, email } = req.body || {};
    let visitorId = req.cookies[VISITOR_COOKIE];
    let isBrandNew = false;

    if (!visitorId) {
      visitorId = crypto.randomUUID();
      isBrandNew = true;
      res.cookie(VISITOR_COOKIE, visitorId, {
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24 * 365, // 1 year — recognizes repeat visitors
        sameSite: IS_PROD ? 'none' : 'lax',
        secure: IS_PROD
      });
    }

    const existing = store.getVisitor(visitorId);
    const ip = getClientIp(req);

    let geo = { ip, country: existing?.country, countryCode: existing?.countryCode, city: existing?.city };
    // Only do a fresh geo lookup for genuinely new visitors (avoid hitting the
    // rate-limited free API on every page reload of a returning visitor).
    if (!existing) {
      geo = await getGeoInfo(ip);
    }

    const visitor = store.upsertVisitor(visitorId, {
      name,
      email,
      ip,
      country: geo.country,
      countryCode: geo.countryCode,
      city: geo.city,
      isNewVisit: !isBrandNew // bump visitCount when a known browser comes back
    });

    const history = store.getMessages(visitorId);

    notifyVisitorsChanged();
    res.json({ visitor, history, isReturning: !!existing });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start session' });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const visitorId = req.cookies[VISITOR_COOKIE];
    const { message } = req.body || {};

    if (!visitorId) return res.status(400).json({ error: 'No session — reload the page' });
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'GEMINI_API_KEY missing. Copy .env.example to .env and add your key.' });
    }

    const visitor = store.getVisitor(visitorId);
    store.addMessage(visitorId, 'user', message);
    notifyNewMessage(visitorId);

    if (isHumanRequest(message)) {
      store.setNeedsHuman(visitorId, true);
      notifyVisitorsChanged();
    }

    const systemPromptRaw = loadFile('system-prompt.md', 'You are a helpful assistant.');
    const knowledge = loadFile('knowledge.md', '');

    const visitorContext = visitor?.name
      ? `\n\n---\nCustomer info: name is ${visitor.name}${visitor.country ? `, visiting from ${visitor.country}` : ''}.`
      : '';

    const fullSystem = `${systemPromptRaw}\n\n---\nReference knowledge:\n${knowledge}${visitorContext}`;

    // Gemini expects roles 'user' and 'model' (not 'assistant'), with text in 'parts'.
    const geminiContents = store.getMessages(visitorId).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: fullSystem }] },
          contents: geminiContents
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('Gemini API error:', data);
      return res.status(response.status).json({ error: data.error?.message || 'API error' });
    }

    const reply = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';

    store.addMessage(visitorId, 'assistant', reply);
    notifyNewMessage(visitorId);
    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Lets the open chat widget poll for new messages (e.g. a manual admin reply)
// without needing a full page reload.
app.get('/api/messages', (req, res) => {
  const visitorId = req.cookies[VISITOR_COOKIE];
  if (!visitorId) return res.status(400).json({ error: 'No session' });
  res.json({ messages: store.getMessages(visitorId) });
});

// ---------- Admin ----------

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Wrong password' });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/admin/me', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.isAdmin) });
});

app.get('/api/admin/visitors', requireAdmin, (req, res) => {
  res.json({ visitors: store.listVisitors() });
});

app.get('/api/admin/visitors/:id/messages', requireAdmin, (req, res) => {
  const visitor = store.getVisitor(req.params.id);
  if (!visitor) return res.status(404).json({ error: 'Not found' });
  res.json({ visitor, messages: store.getMessages(req.params.id) });
});

// Admin sends a message directly to a customer — bypasses Gemini entirely,
// so this is a genuine human reply that shows up in the customer's chat.
app.post('/api/admin/visitors/:id/reply', requireAdmin, (req, res) => {
  const { message } = req.body || {};
  const visitor = store.getVisitor(req.params.id);
  if (!visitor) return res.status(404).json({ error: 'Not found' });
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message is required' });

  store.addMessage(req.params.id, 'assistant', message);
  notifyNewMessage(req.params.id);
  res.json({ ok: true });
});

// Admin marks a "needs human" conversation as handled.
app.post('/api/admin/visitors/:id/resolve', requireAdmin, (req, res) => {
  const visitor = store.setNeedsHuman(req.params.id, false);
  if (!visitor) return res.status(404).json({ error: 'Not found' });
  notifyVisitorsChanged();
  res.json({ ok: true });
});

httpServer.listen(PORT, () => {
  console.log(`Chat agent running at http://localhost:${PORT}`);
  console.log(`Admin dashboard at http://localhost:${PORT}/admin.html`);
});
