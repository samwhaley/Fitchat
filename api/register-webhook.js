const https = require('https');

const clientId = '259347'; // From Strava API app
const clientSecret = '4e4c738412a4aae6c09b14c2bc3756e41955053a'; // From Strava API app
const verifyToken = 'my_verify_token_123'; // Any random string you choose
const callbackUrl = 'https://fitchat-one.vercel.app/api/strava-webhook'; // Your Vercel URL

async function registerWebhook() {
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

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        console.log('Response:', data);
        resolve(data);
      });
    });

    req.on('error', (e) => {
      console.error('Error:', e);
      reject(e);
    });

    req.write(postData);
    req.end();
  });
}

registerWebhook();
