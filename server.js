const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Call external-tool CLI (credentials are injected per-request by the platform)
function callTool(sourceId, toolName, args) {
  const params = JSON.stringify({ source_id: sourceId, tool_name: toolName, arguments: args });
  // Escape single quotes in params for shell safety
  const escaped = params.replace(/'/g, "'\\''");
  try {
    const result = execSync(`external-tool call '${escaped}'`, { timeout: 30000 });
    return JSON.parse(result.toString());
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString() : '';
    throw new Error('Tool call failed: ' + (stderr || e.message));
  }
}

function categorize(subject, from) {
  const s = (subject || '').toLowerCase();
  const f = (from || '').toLowerCase();
  if (/requisition|awaiting approval/i.test(s)) return 'requisition';
  if (/invoice|bill|payment|due/i.test(s)) return 'invoice';
  if (/alert|outage|restored|operational|singlepoint/i.test(s)) return 'alert';
  if (/closed|closure|announcement|board/i.test(s)) return 'announcement';
  if (f.includes('@gdrh.org')) return 'staff';
  return 'other';
}

function prioritize(subject, category) {
  const s = (subject || '').toLowerCase();
  if (/awaiting approval|overdue|urgent|past due/i.test(s)) return 'high';
  if (category === 'requisition' || category === 'invoice') return 'high';
  if (category === 'alert' || category === 'staff') return 'medium';
  return 'low';
}

function extractAmount(text) {
  const m = (text || '').match(/Amount:\s*([\d,]+(?:\.\d{2})?)/i) ||
             (text || '').match(/\$\s*([\d,]+(?:\.\d{2})?)/);
  return m ? m[1].replace(/,/g, '') : null;
}

function extractVendor(text) {
  const m = (text || '').match(/Vendor:\s*([^\n\.]+)/i);
  if (m) return m[1].trim();
  const known = ['speedway','superamerica','kwiktrip','amazon','walmart','grainger',
                 'home depot','staples','anthem','apple','boswell','grackledocs','hi educators'];
  const t = (text || '').toLowerCase();
  for (const v of known) {
    if (t.includes(v)) return v.replace(/\b\w/g, c => c.toUpperCase());
  }
  return null;
}

async function fetchRefreshData() {
  const searches = [
    { query: 'subject:(Requisition "Awaiting Approval") newer_than:3d', max_results: 20 },
    { query: 'subject:(invoice OR Invoice) newer_than:3d', max_results: 10 },
    { query: 'from:SinglePointAlerts@hund.io newer_than:3d', max_results: 5 },
    { query: 'from:@gdrh.org newer_than:2d -from:me subject:(budget OR payment OR finance OR report)', max_results: 10 },
    { query: 'subject:(PayPal OR "US Bank" OR SinglePoint) newer_than:3d', max_results: 5 },
    { query: 'subject:(closed OR closure OR announcement) newer_than:3d', max_results: 5 },
  ];

  const seen = new Set();
  const emails = [];

  for (const s of searches) {
    try {
      const result = callTool('gcal', 'search_email', {
        queries: [s.query],
        max_results: s.max_results,
      });
      const items = result?.email_results?.emails || [];
      for (const e of items) {
        if (seen.has(e.email_id)) continue;
        seen.add(e.email_id);
        const cat = categorize(e.subject, e.from_);
        const bodyText = (e.body || e.snippet || '');
        emails.push({
          id: 'e_' + e.email_id.substring(0, 8),
          emailId: e.email_id,
          subject: e.subject || '(No subject)',
          from_: e.from_ || '',
          date: e.date || new Date().toISOString(),
          snippet: e.snippet || bodyText.substring(0, 200),
          category: cat,
          priority: prioritize(e.subject, cat),
          isActioned: false,
          amount: extractAmount(bodyText),
          vendor: extractVendor(bodyText),
          labels: e.labels || [],
        });
      }
    } catch (err) {
      // Skip failed search, continue with others
      console.error('Search failed:', s.query, err.message);
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
  if (reqs.length > 0) parts.push(reqs.length + ' requisition' + (reqs.length > 1 ? 's' : '') + ' awaiting approval');
  if (invoices.length > 0) parts.push(invoices.length + ' invoice' + (invoices.length > 1 ? 's' : '') + ' need attention');
  if (parts.length > 0) digest += parts.join(', ') + '. ';
  digest += emails.length + ' emails total, ' + high.length + ' high priority.';

  return { emails, digest, timestamp: new Date().toISOString() };
}

const server = http.createServer((req, res) => {
  // CORS headers so the static app can call this endpoint
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url.split('?')[0];

  // API endpoint
  if (url === '/api/refresh') {
    let data;
    try {
      data = fetchRefreshData();
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
      return;
    }
    // fetchRefreshData is sync (execSync), return directly
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data, timestamp: new Date().toISOString() }));
    return;
  }

  // Serve index.html for everything else
  const filePath = path.join(__dirname, 'index.html');
  fs.readFile(filePath, (err, fileData) => {
    if (err) {
      res.writeHead(500);
      res.end('Error loading app');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fileData);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`GDRH Finance Hub running on port ${PORT}`);
});
