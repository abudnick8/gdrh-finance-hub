/**
 * GDRH Gmail OAuth Token Helper
 * 
 * Run this ONCE locally after setting your Client ID and Client Secret below.
 * It prints an auth URL — open it in your browser, authorize, then paste the
 * code back here to get your refresh token for Railway.
 * 
 * Usage:
 *   1. Fill in CLIENT_ID and CLIENT_SECRET from Google Cloud Console
 *   2. node get_token.js
 *   3. Open the URL it prints, authorize with adam.budnick@gdrh.org
 *   4. Copy the "code" from the redirect URL (?code=...)
 *   5. node get_token.js <paste_code_here>
 *   6. Copy the refresh_token printed — paste it into Railway as GOOGLE_REFRESH_TOKEN
 */

const https = require('https');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'YOUR_CLIENT_ID';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'YOUR_CLIENT_SECRET';
const REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob'; // For manual copy-paste flow
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
].join(' ');

const code = process.argv[2];

if (!code) {
  // Step 1: Print auth URL
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
  });
  console.log('\n=== STEP 1: Open this URL in your browser ===\n');
  console.log('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
  console.log('\n=== STEP 2: After authorizing, copy the code shown ===');
  console.log('=== STEP 3: Run: node get_token.js <paste_code_here> ===\n');
} else {
  // Step 2: Exchange code for tokens
  const body = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  }).toString();

  const req = https.request({
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      const json = JSON.parse(data);
      if (json.refresh_token) {
        console.log('\n=== SUCCESS! Add these to Railway as environment variables ===\n');
        console.log('GOOGLE_REFRESH_TOKEN=' + json.refresh_token);
        console.log('\n(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET you already have)\n');
      } else {
        console.log('Error:', data);
      }
    });
  });
  req.on('error', console.error);
  req.write(body);
  req.end();
}
