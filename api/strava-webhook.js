// Strava webhook endpoint for Fitchat.
// IMPORTANT: Keep the GET verification path dependency-free so Strava can
// validate the callback even if another integration is temporarily broken.

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const mode = req.query?.['hub.mode'];
    const verifyToken = req.query?.['hub.verify_token'];
    const challenge = req.query?.['hub.challenge'];

    if (
      mode === 'subscribe' &&
      challenge &&
      verifyToken === process.env.STRAVA_VERIFY_TOKEN
    ) {
      return res.status(200).json({ 'hub.challenge': challenge });
    }

    return res.status(403).json({ error: 'Invalid webhook verification' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const event = req.body || {};

  if (event.object_type !== 'activity' || event.aspect_type !== 'create') {
    return res.status(200).json({ received: true, ignored: true });
  }

  if (!event.object_id) {
    return res.status(200).json({ received: true, ignored: true });
  }

  // Load processing dependencies only for POST events. This keeps Strava's
  // verification GET as simple and reliable as possible.
  try {
    const { waitUntil } = await import('@vercel/functions');
    waitUntil(processActivityEvent(event));
  } catch (error) {
    console.error('Unable to start background processing:', error);
    // Still acknowledge the webhook. Strava only needs the event receipt here.
  }

  return res.status(200).json({ received: true });
}

async function processActivityEvent(event) {
  try {
    const { Octokit } = await import('@octokit/rest');
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    const activityData = await fetchStravaActivityWithRetry(event.object_id);

    if (!activityData || activityData.id == null) {
      throw new Error(`Could not retrieve Strava activity ${event.object_id}`);
    }

    const sessionSummary = processActivity(activityData, event);
    await updateGitHubFile(octokit, sessionSummary);
    console.log(`Fitchat: imported Strava activity ${activityData.id}`);
  } catch (error) {
    console.error('Fitchat Strava processing failed:', error);
  }
}

async function getStravaAccessToken() {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  const refreshToken = process.env.STRAVA_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET or STRAVA_REFRESH_TOKEN');
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const response = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(`Strava token refresh failed (${response.status}): ${JSON.stringify(data)}`);
  }

  if (data.refresh_token && data.refresh_token !== refreshToken) {
    console.warn('Strava returned a new refresh token. Update STRAVA_REFRESH_TOKEN in Vercel.');
  }

  return data.access_token;
}

async function fetchStravaActivityWithRetry(activityId) {
  const accessToken = await getStravaAccessToken();
  let lastError;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (response.ok) return await response.json();

      const body = await response.text();
      lastError = new Error(`Strava activity request failed (${response.status}): ${body}`);

      if (response.status === 404 || response.status >= 500) {
        await sleep(750 * (attempt + 1));
        continue;
      }
      throw lastError;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(750 * (attempt + 1));
    }
  }

  throw lastError || new Error(`Unable to fetch activity ${activityId}`);
}

function processActivity(activityData, event) {
  const laps = Array.isArray(activityData.laps) ? activityData.laps : [];
  const intervals = laps.map((lap) => ({
    lapNumber: lap.lap_index != null ? lap.lap_index + 1 : null,
    duration: lap.elapsed_time ?? null,
    movingTime: lap.moving_time ?? null,
    distance: lap.distance ?? null,
    avgPower: lap.average_watts ?? null,
    maxPower: lap.max_watts ?? null,
    avgHR: lap.average_heartrate ?? null,
    maxHR: lap.max_heartrate ?? null,
    startTime: lap.start_date ?? null,
  }));

  return {
    stravaActivityId: activityData.id,
    stravaOwnerId: event.owner_id ?? activityData.athlete?.id ?? null,
    date: new Date(activityData.start_date).toISOString().split('T')[0],
    timestamp: new Date(activityData.start_date).getTime(),
    name: activityData.name ?? 'Strava activity',
    type: activityData.type ?? null,
    duration: activityData.moving_time ?? 0,
    distance: activityData.distance ?? 0,
    elevation: activityData.total_elevation_gain ?? 0,
    avgPower: activityData.average_watts ?? null,
    maxPower: activityData.max_watts ?? null,
    avgHR: activityData.average_heartrate ?? null,
    maxHR: activityData.max_heartrate ?? null,
    intervals,
  };
}

async function updateGitHubFile(octokit, sessionSummary) {
  const repo = process.env.GITHUB_REPO;
  const filePath = process.env.GITHUB_DATA_FILE || 'fitness-data.json';
  if (!repo || !process.env.GITHUB_TOKEN) throw new Error('Missing GITHUB_REPO or GITHUB_TOKEN');

  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) throw new Error('GITHUB_REPO must be in owner/repository format');

  let currentData = { sessions: [], master: {} };
  let sha;

  try {
    const fileRes = await octokit.repos.getContent({ owner, repo: repoName, path: filePath });
    if (Array.isArray(fileRes.data)) throw new Error(`${filePath} is a directory, not a file`);
    sha = fileRes.data.sha;
    currentData = JSON.parse(Buffer.from(fileRes.data.content, 'base64').toString('utf8'));
  } catch (error) {
    if (error.status !== 404) throw error;
  }

  if (!Array.isArray(currentData.sessions)) currentData.sessions = [];
  if (currentData.sessions.some((s) => String(s.stravaActivityId) === String(sessionSummary.stravaActivityId))) return;

  currentData.sessions.push(sessionSummary);
  currentData.sessions.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  currentData.master = calculateMasterStats(currentData.sessions);

  const params = {
    owner,
    repo: repoName,
    path: filePath,
    message: `Update fitness data: ${sessionSummary.date} - ${sessionSummary.name}`,
    content: Buffer.from(JSON.stringify(currentData, null, 2)).toString('base64'),
  };
  if (sha) params.sha = sha;
  await octokit.repos.createOrUpdateFileContents(params);
}

function calculateMasterStats(sessions) {
  if (!sessions.length) return {};
  const sorted = [...sessions].sort((a, b) => new Date(a.date) - new Date(b.date));
  const bestEfforts = { oneMin: 0, threeMin: 0, fiveMin: 0, tenMin: 0, twentyMin: 0 };

  for (const session of sorted) {
    for (const interval of session.intervals || []) {
      const power = Number(interval.avgPower);
      if (!Number.isFinite(power)) continue;
      const min = Number(interval.duration) / 60;
      if (min <= 1.5) bestEfforts.oneMin = Math.max(bestEfforts.oneMin, power);
      else if (min <= 3.5) bestEfforts.threeMin = Math.max(bestEfforts.threeMin, power);
      else if (min <= 6) bestEfforts.fiveMin = Math.max(bestEfforts.fiveMin, power);
      else if (min <= 12) bestEfforts.tenMin = Math.max(bestEfforts.tenMin, power);
      else if (min <= 25) bestEfforts.twentyMin = Math.max(bestEfforts.twentyMin, power);
    }
  }

  const recent = sorted.slice(-4);
  const recent10 = recent.flatMap((s) => (s.intervals || [])
    .filter((i) => Number(i.duration) / 60 >= 9 && Number(i.duration) / 60 <= 11)
    .map((i) => Number(i.avgPower))
    .filter(Number.isFinite));

  const estimatedFTP = bestEfforts.twentyMin > 0
    ? Math.round(bestEfforts.twentyMin * 0.95)
    : recent10.length ? Math.round(recent10.reduce((a, b) => a + b, 0) / recent10.length) : 0;

  const eightWeeksAgo = new Date();
  eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);
  const weeklyVolume = {};
  for (const session of sorted.filter((s) => new Date(s.date) >= eightWeeksAgo)) {
    const weekStart = getWeekStart(new Date(session.date));
    const key = weekStart.toISOString().split('T')[0];
    weeklyVolume[key] ||= { hours: 0, km: 0 };
    weeklyVolume[key].hours += (session.duration || 0) / 3600;
    weeklyVolume[key].km += (session.distance || 0) / 1000;
  }

  const hrAtPower = {};
  for (const session of sorted) {
    for (const interval of session.intervals || []) {
      const power = Number(interval.avgPower);
      const hr = Number(interval.avgHR);
      if (!Number.isFinite(power) || !Number.isFinite(hr)) continue;
      const zone = Math.round(power / 50) * 50;
      (hrAtPower[zone] ||= []).push(hr);
    }
  }
  const hrTrends = Object.fromEntries(Object.entries(hrAtPower).map(([z, hrs]) => [z, Math.round(hrs.reduce((a,b)=>a+b,0)/hrs.length)]));

  return {
    totalSessions: sessions.length,
    totalHours: Math.round(sorted.reduce((sum, s) => sum + (s.duration || 0) / 3600, 0) * 10) / 10,
    bestEfforts,
    estimatedFTP,
    weeklyVolume,
    goals: {
      goal350w10min: { target: 350, duration: '10min', currentBest: bestEfforts.tenMin, onTrack: bestEfforts.tenMin >= 330 },
      goal500w3min: { target: 500, duration: '3min', currentBest: bestEfforts.threeMin, onTrack: bestEfforts.threeMin >= 450 },
    },
    hrTrends,
    recentSessions: sorted.slice(-5).reverse(),
    lastUpdated: new Date().toISOString(),
  };
}

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
