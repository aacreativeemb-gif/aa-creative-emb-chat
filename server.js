require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const store = require('./lib/store');
const { getGeoInfo, getClientIp } = require('./lib/geo');

const app = express();
app.set('trust proxy', true); // needed so req IP is correct behind Render/Vercel/etc. proxies

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-this-secret';
const MODEL = 'claude-sonnet-4-6';

// When the chat widget is embedded in an iframe on a different domain
// (e.g. aacreativeemb.com embeds a widget hosted on chat.aacreativeemb.com),
// the visitor cookie must be SameSite=None + Secure to survive that
// cross-site context — which only works over HTTPS. Locally (http) we fall
// back to Lax so testing on localhost still works.
const IS_PROD = process.env.NODE_ENV === 'production';

app.use(express.json());
app.use(cookieParser());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 8 } // 8 hour admin session
  })
);
app.use(express.static(path.join(__dirname, 'public')));

function loadFile(filename, fallback) {
  try {
    return fs.readFileSync(path.join(__dirname, filename), 'utf8');
  } catch (e) {
    return fallback;
  }
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
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing. Copy .env.example to .env and add your key.' });
    }

    const visitor = store.getVisitor(visitorId);
    store.addMessage(visitorId, 'user', message);

    const systemPromptRaw = loadFile('system-prompt.md', 'You are a helpful assistant.');
    const knowledge = loadFile('knowledge.md', '');

    const visitorContext = visitor?.name
      ? `\n\n---\nCustomer info: name is ${visitor.name}${visitor.country ? `, visiting from ${visitor.country}` : ''}.`
      : '';

    const fullSystem = `${systemPromptRaw}\n\n---\nReference knowledge:\n${knowledge}${visitorContext}`;

    const history = store.getMessages(visitorId).map(m => ({ role: m.role, content: m.content }));

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: fullSystem,
        messages: history
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic API error:', data);
      return res.status(response.status).json({ error: data.error?.message || 'API error' });
    }

    const textBlock = (data.content || []).find(b => b.type === 'text');
    const reply = textBlock ? textBlock.text : '';

    store.addMessage(visitorId, 'assistant', reply);
    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
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

app.listen(PORT, () => {
  console.log(`Chat agent running at http://localhost:${PORT}`);
  console.log(`Admin dashboard at http://localhost:${PORT}/admin.html`);
});
