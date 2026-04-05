const express = require('express');
const cron = require('node-cron');
const path = require('path');
const { getEvents, getLatestDigest } = require('./store');
const { runAll } = require('./runner');
const { analyzeWithGrok } = require('./analyzer');

const app = express();
const PORT = 3737;
const API_KEY = process.env.GROK_API_KEY;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ────────────────────────────────────────────────────────────────

// Current digest (last Grok analysis)
app.get('/api/digest', (req, res) => {
  const digest = getLatestDigest();
  res.json(digest || { error: 'No digest yet — collection still running' });
});

// Raw events with optional filters
app.get('/api/events', (req, res) => {
  const { source, hours = 72, anomalyOnly } = req.query;
  const since = Date.now() - parseInt(hours) * 3600000;
  const events = getEvents({
    source: source || undefined,
    since,
    anomalyOnly: anomalyOnly === 'true',
    limit: 500,
  });
  res.json({ events, count: events.length });
});

// Trigger manual collection + analysis
app.post('/api/collect', async (req, res) => {
  res.json({ status: 'started' });
  runAll(API_KEY);
});

// Trigger manual analysis only
app.post('/api/analyze', async (req, res) => {
  if (!API_KEY) return res.status(400).json({ error: 'GROK_API_KEY not set' });
  const result = await analyzeWithGrok(API_KEY);
  res.json(result);
});

// Status — which sources have data
app.get('/api/status', (req, res) => {
  const since = Date.now() - 24 * 3600000;
  const sources = ['SEISMIC', 'FIRMS', 'OIL', 'ADSB', 'AIS', 'OFFICIAL', 'TENDER'];
  const status = {};
  for (const s of sources) {
    const events = getEvents({ source: s, since });
    const anomalies = events.filter(e => e.anomaly);
    status[s] = {
      count: events.length,
      anomalies: anomalies.length,
      lastTs: events.length ? events[events.length - 1].ts : null,
      ok: events.length > 0,
    };
  }
  res.json(status);
});

// ── Schedule ──────────────────────────────────────────────────────────────────
// Collect every 15 minutes, each collector runs at its own interval internally
cron.schedule('*/15 * * * *', () => runAll(API_KEY));
// Full re-analysis every 6 hours even if no new anomalies
cron.schedule('0 */6 * * *', () => { if (API_KEY) analyzeWithGrok(API_KEY); });

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n✓ Raw Signal Monitor — http://localhost:${PORT}`);
  console.log(`  Grok API: ${API_KEY ? '✓ loaded' : '✗ missing — set GROK_API_KEY'}`);
  console.log(`  Sources: SEISMIC · FIRMS · OIL · ADSB · AIS · OFFICIAL · TENDER`);
  console.log(`  Collection: every 15min | Analysis: every 6h\n`);
  // Run immediately on startup
  console.log('[STARTUP] Running initial collection...');
  await runAll(API_KEY);
});
