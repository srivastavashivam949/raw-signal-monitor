const express = require('express');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');
const { getEvents, getLatestDigest, getBaseline } = require('./store');
const { runAll } = require('./runner');
const { analyzeWithGrok } = require('./analyzer');

const app = express();
const PORT = process.env.PORT || 3737;
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
// Baseline key mapping: which baseline key(s) each source uses for anomaly detection
const BASELINE_KEYS = {
  SEISMIC: ['earthquake'],
  FIRMS: ['IND', 'PAK', 'IRN', 'IRQ', 'SAU', 'ARE', 'OMN', 'YEM', 'AFG', 'CHN'],
  OIL: ['BZ=F', 'CL=F'],
  ADSB: ['Kashmir/LAC', 'Pakistan-India border', 'Strait of Hormuz', 'South China Sea', 'Taiwan Strait', 'Arabian Sea'],
  AIS: ['Strait of Hormuz', 'Strait of Malacca', 'Bab-el-Mandeb'],
  OFFICIAL: [],
  TENDER: [],
};
app.get('/api/status', (req, res) => {
  const since = Date.now() - 24 * 3600000;
  const sources = ['SEISMIC', 'FIRMS', 'OIL', 'ADSB', 'AIS', 'OFFICIAL', 'TENDER'];
  const status = {};
  for (const s of sources) {
    const events = getEvents({ source: s, since });
    const anomalies = events.filter(e => e.anomaly);
    // Check if any baseline key for this source has >= 12 samples
    const keys = BASELINE_KEYS[s] || [];
    const noBaseline = keys.length === 0; // source intentionally has no numeric baseline (e.g. OFFICIAL, TENDER)
    const hasBaseline = noBaseline ? false :
      keys.some(k => { const b = getBaseline(s, k); return b && b.values.length >= 12; });
    status[s] = {
      count: events.length,
      anomalies: anomalies.length,
      lastTs: events.length ? events[events.length - 1].ts : null,
      ok: events.length > 0,
      detectionActive: hasBaseline,
      detectionApplicable: !noBaseline,
    };
  }
  res.json(status);
});

// ── Data Migration ────────────────────────────────────────────────────────────
// On first boot after a deploy, copy any existing data from wwwroot/data to
// DATA_DIR (/home/data on Azure) so nothing is lost. Idempotent — skips files
// that already exist in the target directory.
function migrateDataIfNeeded() {
  const targetDir = process.env.DATA_DIR;
  if (!targetDir) return; // local dev — nothing to do
  const files = ['events.json', 'baselines.json', 'digests.json'];
  const sourceDir = path.join(__dirname, 'data');
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
  let migrated = 0;
  for (const file of files) {
    const dest = path.join(targetDir, file);
    if (fs.existsSync(dest)) continue; // already there — skip
    const src = path.join(sourceDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      console.log(`[MIGRATE] Copied ${file} → ${targetDir}`);
      migrated++;
    }
  }
  if (!migrated) console.log(`[MIGRATE] ${targetDir} already populated — no migration needed`);
}
migrateDataIfNeeded();

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
