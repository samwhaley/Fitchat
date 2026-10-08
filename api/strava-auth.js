import crypto from 'crypto';

export default function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  const clientId = process.env.STRAVA_CLIENT_ID;
  const redirectUri = process.env.STRAVA_REDIRECT_URI;
  const stateSecret = process.env.STRAVA_OAUTH_STATE_SECRET;

  if (!clientId || !redirectUri || !stateSecret) {
    return res.status(500).json({
      error:
        'Missing STRAVA_CLIENT_ID, STRAVA_REDIRECT_URI or STRAVA_OAUTH_STATE_SECRET',
    });
  }

  const state = crypto
    .createHmac('sha256', stateSecret)
    .update('fitchat-strava-oauth')
    .digest('hex');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    approval_prompt: 'force',
    scope: 'activity:read_all',
    state,
  });

  return res.redirect(`https://www.strava.com/oauth/authorize?${params}`);
}
