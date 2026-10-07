import { Octokit } from "@octokit/rest";

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

export default async function handler(req, res) {
  if (req.method === "GET") {
    const { hub_challenge } = req.query;
    if (hub_challenge) {
      return res.status(200).json({ hub_challenge });
    }
  }

  if (req.method === "POST") {
    try {
      const activity = req.body.object_id;
      const stravaToken = process.env.STRAVA_TOKEN;

      const activityRes = await fetch(
        `https://www.strava.com/api/v3/activities/${activity}`,
        {
          headers: { Authorization: `Bearer ${stravaToken}` },
        }
      );
      const activityData = await activityRes.json();

      const sessionSummary = processActivity(activityData);
      await updateGitHubFile(sessionSummary);

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: error.message });
    }
  }

  res.status(405).end();
}

async function updateGitHubFile(sessionSummary) {
  const repo = process.env.GITHUB_REPO;
  const [owner, repoName] = repo.split("/");
  const filePath = "fitness-data.json";

  try {
    let currentData = { sessions: [], master: {} };
    try {
      const fileRes = await octokit.repos.getContent({
        owner,
        repo: repoName,
        path: filePath,
      });
      currentData = JSON.parse(
        Buffer.from(fileRes.data.content, "base64").toString()
      );
    } catch (error) {
      console.log("Creating new fitness file");
    }

    currentData.sessions.push(sessionSummary);
    currentData.master = calculateMasterStats(currentData.sessions);

    const fileContent = JSON.stringify(currentData, null, 2);
    const encodedContent = Buffer.from(fileContent).toString("base64");

    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo: repoName,
      path: filePath,
      message: `Update fitness data: ${sessionSummary.date}`,
      content: encodedContent,
    });

    console.log("Fitness file updated successfully");
  } catch (error) {
    console.error("GitHub update failed:", error);
    throw error;
  }
}

function processActivity(activityData) {
  const { name, type, start_date, distance, total_elevation_gain, average_heartrate, max_heartrate, average_watts, max_watts, laps } = activityData;

  const intervals = laps.map((lap) => ({
    lapNumber: lap.lap_index + 1,
    duration: lap.elapsed_time,
    distance: lap.distance,
    avgPower: lap.average_watts || null,
    maxPower: lap.max_watts || null,
    avgHR: lap.average_heartrate || null,
    maxHR: lap.max_heartrate || null,
    startTime: lap.start_index || 0,
  }));

  const sessionSummary = {
    date: new Date(start_date).toISOString().split('T')[0],
    timestamp: new Date(start_date).getTime(),
    name,
    type,
    duration: activityData.moving_time,
    distance,
    elevation: total_elevation_gain,
    avgPower: average_watts,
    maxPower: max_watts,
    avgHR: average_heartrate,
    maxHR: max_heartrate,
    intervals,
  };

  return sessionSummary;
}

function calculateMasterStats(sessions) {
  if (sessions.length === 0) return {};

  const sorted = [...sessions].sort(
    (a, b) => new Date(a.date) - new Date(b.date)
  );

  let bestEfforts = {
    oneMin: 0,
    fiveMin: 0,
    tenMin: 0,
    twentyMin: 0,
  };

  sorted.forEach((session) => {
    session.intervals.forEach((interval) => {
      const durationMin = interval.duration / 60;
      if (durationMin <= 1.5) {
        bestEfforts.oneMin = Math.max(bestEfforts.oneMin, interval.avgPower);
      } else if (durationMin <= 6) {
        bestEfforts.fiveMin = Math.max(bestEfforts.fiveMin, interval.avgPower);
      } else if (durationMin <= 12) {
        bestEfforts.tenMin = Math.max(bestEfforts.tenMin, interval.avgPower);
      } else if (durationMin <= 25) {
        bestEfforts.twentyMin = Math.max(
          bestEfforts.twentyMin,
          interval.avgPower
        );
      }
    });
  });

  const recentSessions = sorted.slice(-4);
  const recent10MinEfforts = [];
  recentSessions.forEach((session) => {
    session.intervals.forEach((interval) => {
      const durationMin = interval.duration / 60;
      if (durationMin >= 9 && durationMin <= 11) {
        recent10MinEfforts.push(interval.avgPower);
      }
    });
  });

  let estimatedFTP =
    bestEfforts.twentyMin > 0
      ? Math.round(bestEfforts.twentyMin * 0.95)
      : recent10MinEfforts.length > 0
      ? Math.round(
          recent10MinEfforts.reduce((a, b) => a + b) /
            recent10MinEfforts.length
        )
      : 0;

  const eightWeeksAgo = new Date();
  eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);
  const recentSessions8w = sorted.filter(
    (s) => new Date(s.date) >= eightWeeksAgo
  );

  const weeklyVolume = {};
  recentSessions8w.forEach((session) => {
    const weekStart = getWeekStart(new Date(session.date));
    const weekKey = weekStart.toISOString().split("T")[0];
    if (!weeklyVolume[weekKey]) {
      weeklyVolume[weekKey] = { hours: 0, km: 0 };
    }
    weeklyVolume[weekKey].hours += session.duration / 3600;
    weeklyVolume[weekKey].km += session.distance / 1000;
  });

  const goals = {
    goal350w10min: {
      target: 350,
      duration: "10min",
      currentBest: bestEfforts.tenMin,
      onTrack: bestEfforts.tenMin >= 330,
    },
    goal500w3min: {
      target: 500,
      duration: "3min",
      currentBest: bestEfforts.oneMin,
      onTrack: bestEfforts.oneMin >= 450,
    },
  };

  const hrAtPower = {};
  sorted.forEach((session) => {
    session.intervals.forEach((interval) => {
      const powerZone = Math.round(interval.avgPower / 50) * 50;
      if (!hrAtPower[powerZone]) {
        hrAtPower[powerZone] = [];
      }
      if (interval.avgHR) hrAtPower[powerZone].push(interval.avgHR);
    });
  });

  const hrTrends = {};
  Object.keys(hrAtPower).forEach((zone) => {
    const hrs = hrAtPower[zone];
    hrTrends[zone] = Math.round(
      hrs.reduce((a, b) => a + b) / hrs.length
    );
  });

  const recentFive = sorted.slice(-5).reverse();

  return {
    totalSessions: sessions.length,
    totalHours: Math.round(
      sorted.reduce((sum, s) => sum + s.duration / 3600, 0) * 10
    ) / 10,
    bestEfforts,
    estimatedFTP,
    weeklyVolume,
    goals,
    hrTrends,
    recentSessions: recentFive,
    lastUpdated: new Date().toISOString(),
  };
}

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
}
