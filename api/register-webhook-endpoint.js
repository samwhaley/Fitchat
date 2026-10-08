import https from 'https';

export default async function handler(req, res) {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(400).json({ error: 'Missing client credentials', clientId: !!clientId, clientSecret: !!clientSecret });
  }

  const verifyToken = 'my_verify_token_123';
  const callbackUrl = 'https://fitchat-one.vercel.app/api/strava-webhook';

  const postData = JSON.stringify({
    client_id: clientId,
    client_secret: clientSecret,
    callback_url: callbackUrl,
    verify_token: verifyToken,
  });

  const options = {
    hostname: 'api.strava.com',
    path: '/v3/push_subscriptions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': postData.length,
    },
  };

  return new Promise((resolve) => {
    const apiReq = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', (chunk) => {
        data += chunk;
      });
      apiRes.on('end', () => {
        console.log('Strava response:', data);
        resolve(res.status(200).json({ success: true, response: JSON.parse(data) }));
      });
    });

    apiReq.on('error', (e) => {
      console.error('Request error:', e.message);
      resolve(res.status(500).json({ error: e.message }));
    });

    apiReq.write(postData);
    apiReq.end();
  });
}
