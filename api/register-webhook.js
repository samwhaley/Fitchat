export default async function handler(req, res) {
  const configuredSecret = process.env.REGISTER_WEBHOOK_SECRET;

  if (!configuredSecret) return res.status(500).json({ error: 'REGISTER_WEBHOOK_SECRET is not configured in Vercel.' });

  if (req.method === 'GET') {
    return res.status(200).send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Fitchat Strava Setup</title></head><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:520px;margin:40px auto;padding:20px"><h2>Fitchat Strava webhook</h2><p>Enter the one-time registration secret from your Vercel environment variables.</p><form method="POST"><input name="secret" type="password" required style="width:100%;box-sizing:border-box;padding:12px;margin:10px 0"><button type="submit" style="padding:12px 18px">Register webhook</button></form></body></html>`);
  }

  if (req.method !== 'POST') return res.status(405).end();

  if (req.body?.secret !== configuredSecret) return res.status(403).json({ error: 'Invalid registration secret.' });

  const { STRAVA_CLIENT_ID: clientId, STRAVA_CLIENT_SECRET: clientSecret, STRAVA_VERIFY_TOKEN: verifyToken, STRAVA_WEBHOOK_URL: callbackUrl } = process.env;
  if (!clientId || !clientSecret || !verifyToken || !callbackUrl) return res.status(500).json({ error: 'Missing Strava environment variables.' });

  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, callback_url: callbackUrl, verify_token: verifyToken });
  const response = await fetch('https://www.strava.com/api/v3/push_subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return res.status(response.ok ? 200 : response.status).json(data);
}
