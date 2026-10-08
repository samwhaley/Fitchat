import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  const { code, state, error, scope } = req.query;

  if (error) {
    return res.status(400).send(`Strava authorization failed: ${escapeHtml(error)}`);
  }

  const stateSecret = process.env.STRAVA_OAUTH_STATE_SECRET;
  const expectedState = crypto
    .createHmac('sha256', stateSecret || '')
    .update('fitchat-strava-oauth')
    .digest('hex');

  if (!state || state !== expectedState) {
    return res.status(403).send('Invalid OAuth state. Start again from /api/strava-auth.');
  }

  if (!code) {
    return res.status(400).send('Missing authorization code.');
  }

  const body = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID || '',
    client_secret: process.env.STRAVA_CLIENT_SECRET || '',
    code,
    grant_type: 'authorization_code',
  });

  const tokenResponse = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await tokenResponse.json();

  if (!tokenResponse.ok || !data.refresh_token) {
    console.error('Strava OAuth exchange failed:', data);
    return res.status(400).json({ error: 'Strava token exchange failed', details: data });
  }

  const athleteName = [data.athlete?.firstname, data.athlete?.lastname]
    .filter(Boolean)
    .join(' ');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(`<!doctype html>
<html>
<head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fitchat Strava connected</title></head>
<body style="font-family:system-ui;max-width:700px;margin:40px auto;padding:20px;line-height:1.5">
<h1>Strava connected ✓</h1>
<p>Authorized athlete: <strong>${escapeHtml(athleteName || 'your Strava account')}</strong></p>
<p>Granted scope: <strong>${escapeHtml(scope || data.scope || '')}</strong></p>
<p><strong>Copy the refresh token below into the Vercel environment variable <code>STRAVA_REFRESH_TOKEN</code>.</strong></p>
<textarea readonly style="width:100%;height:90px;font-family:monospace">${escapeHtml(data.refresh_token)}</textarea>
<p>Keep this token private. Then redeploy Fitchat. You can close this page afterwards.</p>
</body></html>`);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
