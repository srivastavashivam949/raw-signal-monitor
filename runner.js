const { addEvents } = require('./store');
const {
  collectSeismic,
  collectFIRMS,
  collectOilPrice,
  collectADSB,
  collectAIS,
  collectOfficial,
  collectProcurement,
} = require('./collectors');
const { analyzeWithGrok } = require('./analyzer');

const COLLECTORS = [
  { name: 'SEISMIC',     fn: collectSeismic,     intervalMin: 60  },
  { name: 'FIRMS',       fn: collectFIRMS,        intervalMin: 180 },
  { name: 'OIL',         fn: collectOilPrice,     intervalMin: 30  },
  { name: 'ADSB',        fn: collectADSB,         intervalMin: 60  },
  { name: 'AIS',         fn: collectAIS,          intervalMin: 60  },
  { name: 'OFFICIAL',    fn: collectOfficial,     intervalMin: 120 },
  { name: 'PROCUREMENT', fn: collectProcurement,  intervalMin: 360 },
];

const lastRun = {};
let isAnalyzing = false;

async function runCollector(c) {
  const now = Date.now();
  const last = lastRun[c.name] || 0;
  if (now - last < c.intervalMin * 60 * 1000) return;
  lastRun[c.name] = now;

  process.stdout.write(`[${c.name}] collecting... `);
  try {
    const events = await c.fn();
    const added = addEvents(events);
    console.log(`${events.length} events, ${added} new`);
  } catch (e) {
    console.log(`error: ${e.message}`);
  }
}

async function runAll(apiKey) {
  console.log(`\n[COLLECT] ${new Date().toISOString()}`);
  await Promise.allSettled(COLLECTORS.map(runCollector));

  if (apiKey && !isAnalyzing) {
    isAnalyzing = true;
    console.log('[ANALYZE] Running Grok analysis...');
    try {
      await analyzeWithGrok(apiKey);
      console.log('[ANALYZE] Done');
    } catch (e) {
      console.error('[ANALYZE] Error:', e.message);
    }
    isAnalyzing = false;
  }
}

module.exports = { runAll };
