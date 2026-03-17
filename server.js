const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ---- GOOGLE OAUTH2 TOKEN REFRESH ----
async function getAccessToken() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing Google OAuth env vars. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN in Railway.');
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) resolve(json.access_token);
          else reject(new Error('Token refresh failed: ' + data));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---- GMAIL API SEARCH ----
async function gmailSearch(accessToken, query, maxResults = 20) {
  const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`;

  const ids = await httpsGet(url, accessToken);
  const messages = ids.messages || [];
  if (messages.length === 0) return [];

  // Fetch each message in parallel (batch of up to 20)
  const results = await Promise.all(
    messages.slice(0, maxResults).map(m => gmailGetMessage(accessToken, m.id))
  );
  return results.filter(Boolean);
}

async function gmailGetMessage(accessToken, id) {
  try {
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`;
    return await httpsGet(url, accessToken);
  } catch (e) {
    return null;
  }
}

function httpsGet(url, accessToken) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: { Authorization: 'Bearer ' + accessToken },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---- PARSE GMAIL MESSAGE ----
function parseMessage(msg) {
  if (!msg || !msg.payload) return null;

  const headers = msg.payload.headers || [];
  const get = (name) => (headers.find(h => h.name.toLowerCase() === name.toLowerCase()) || {}).value || '';

  const subject = get('Subject') || '(No subject)';
  const from = get('From');
  const date = get('Date');
  const labelIds = msg.labelIds || [];

  // Get body text
  let body = '';
  function extractBody(part) {
    if (!part) return;
    if (part.mimeType === 'text/plain' && part.body && part.body.data) {
      body += Buffer.from(part.body.data, 'base64').toString('utf-8');
    }
    if (part.parts) part.parts.forEach(extractBody);
  }
  extractBody(msg.payload);

  const snippet = msg.snippet || body.substring(0, 200);

  return {
    emailId: msg.id,
    subject,
    from_: from,
    date: date ? new Date(date).toISOString() : new Date().toISOString(),
    snippet: snippet.substring(0, 200),
    body: body.substring(0, 1000),
    labels: labelIds,
  };
}

// ---- CATEGORIZE + PRIORITIZE ----
function categorize(subject) {
  if (/requisition|awaiting approval/i.test(subject)) return 'requisition';
  if (/invoice|bill|payment|due/i.test(subject)) return 'invoice';
  if (/alert|outage|restored|operational|singlepoint/i.test(subject)) return 'alert';
  if (/closed|closure|announcement|board/i.test(subject)) return 'announcement';
  return 'staff';
}

function prioritize(subject, category) {
  if (/awaiting approval|overdue|urgent|past due/i.test(subject)) return 'high';
  if (category === 'requisition' || category === 'invoice') return 'high';
  if (category === 'alert') return 'medium';
  return 'medium';
}

function extractAmount(text) {
  const m = (text || '').match(/Amount:\s*([\d,]+(?:\.\d{2})?)/i) || (text || '').match(/\$\s*([\d,]+(?:\.\d{2})?)/);
  return m ? m[1].replace(/,/g, '') : null;
}

function extractVendor(text) {
  const m = (text || '').match(/Vendor:\s*([^\n.]+)/i);
  if (m) return m[1].trim();
  const known = ['speedway', 'superamerica', 'kwiktrip', 'amazon', 'walmart', 'grainger',
    'home depot', 'staples', 'anthem', 'apple', 'boswell', 'grackledocs', 'hi educators'];
  const t = (text || '').toLowerCase();
  for (const v of known) {
    if (t.includes(v)) return v.replace(/\b\w/g, c => c.toUpperCase());
  }
  return null;
}

// ---- MAIN REFRESH ----
async function fetchRefreshData() {
  const accessToken = await getAccessToken();

  const searches = [
    { query: 'subject:(Requisition "Awaiting Approval") newer_than:3d', max: 20 },
    { query: 'subject:(invoice OR Invoice) newer_than:3d', max: 10 },
    { query: 'from:SinglePointAlerts@hund.io newer_than:3d', max: 5 },
    { query: 'from:@gdrh.org newer_than:2d -from:me', max: 15 },
    { query: 'subject:(PayPal OR "US Bank" OR SinglePoint) newer_than:3d', max: 5 },
    { query: 'subject:(closed OR closure OR announcement) newer_than:3d', max: 5 },
  ];

  const seen = new Set();
  const emails = [];

  for (const s of searches) {
    try {
      const raw = await gmailSearch(accessToken, s.query, s.max);
      for (const msg of raw) {
        const parsed = parseMessage(msg);
        if (!parsed || seen.has(parsed.emailId)) continue;
        seen.add(parsed.emailId);
        const cat = categorize(parsed.subject);
        const bodyText = parsed.body || parsed.snippet;
        emails.push({
          id: 'e_' + parsed.emailId.substring(0, 8),
          emailId: parsed.emailId,
          subject: parsed.subject,
          from_: parsed.from_,
          date: parsed.date,
          snippet: parsed.snippet,
          category: cat,
          priority: prioritize(parsed.subject, cat),
          isActioned: false,
          amount: extractAmount(bodyText),
          vendor: extractVendor(bodyText),
          labels: parsed.labels,
        });
      }
    } catch (err) {
      console.error('Search failed:', s.query.substring(0, 40), '-', err.message.substring(0, 100));
    }
  }

  // Sort: high first, then by date desc
  emails.sort((a, b) => {
    const order = { high: 0, medium: 1, low: 2 };
    const pd = (order[a.priority] || 1) - (order[b.priority] || 1);
    if (pd !== 0) return pd;
    return new Date(b.date) - new Date(a.date);
  });

  // Build digest
  const high = emails.filter(e => e.priority === 'high');
  const reqs = emails.filter(e => e.category === 'requisition');
  const invoices = emails.filter(e => e.category === 'invoice');
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  let digest = today + ' — ';
  const parts = [];
  if (reqs.length > 0) parts.push(reqs.length + ' requisition' + (reqs.length !== 1 ? 's' : '') + ' awaiting approval');
  if (invoices.length > 0) parts.push(invoices.length + ' invoice' + (invoices.length !== 1 ? 's' : '') + ' need attention');
  digest += parts.length > 0 ? parts.join(', ') + '. ' : '';
  digest += emails.length + ' emails total, ' + high.length + ' high priority.';

  return { emails, digest, timestamp: new Date().toISOString() };
}

// ---- HTTP SERVER ----
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  if (url === '/api/refresh') {
    try {
      const data = await fetchRefreshData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data, timestamp: new Date().toISOString() }));
    } catch (err) {
      console.error('Refresh error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, time: new Date().toISOString() }));
    return;
  }

  // Serve index.html
  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, fileData) => {
    if (err) { res.writeHead(500); res.end('Error loading app'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fileData);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`GDRH Finance Hub running on port ${PORT}`);
});
