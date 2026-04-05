const fetch = require('node-fetch');
const { getEvents, saveDigest } = require('./store');

// ── Anomaly Clustering ────────────────────────────────────────────────────────
// Groups raw anomalies by time window and geographic proximity
// This is pure math — no interpretation

function clusterAnomalies(events) {
  const anomalies = events.filter(e => e.anomaly);
  if (!anomalies.length) return [];

  const clusters = [];
  const used = new Set();

  for (let i = 0; i < anomalies.length; i++) {
    if (used.has(i)) continue;
    const cluster = [anomalies[i]];
    used.add(i);

    for (let j = i + 1; j < anomalies.length; j++) {
      if (used.has(j)) continue;
      const a = anomalies[i];
      const b = anomalies[j];

      // Time proximity: within 48h of each other
      const timeDiff = Math.abs(a.ts - b.ts) / 3600000; // hours
      if (timeDiff > 48) continue;

      // Geo proximity: if both have coords, within ~500km
      let geoClose = true;
      if (a.lat && b.lat) {
        const dlat = Math.abs(a.lat - b.lat);
        const dlon = Math.abs(a.lon - b.lon);
        geoClose = dlat < 5 && dlon < 5; // ~500km
      }

      if (geoClose) {
        cluster.push(anomalies[j]);
        used.add(j);
      }
    }

    clusters.push({
      events: cluster,
      maxScore: Math.max(...cluster.map(e => e.anomaly.score)),
      sources: [...new Set(cluster.map(e => e.source))],
      timeSpanHours: cluster.length > 1
        ? Math.round((Math.max(...cluster.map(e => e.ts)) - Math.min(...cluster.map(e => e.ts))) / 3600000)
        : 0,
    });
  }

  return clusters.sort((a, b) => b.maxScore - a.maxScore);
}

// ── Grok Analysis ─────────────────────────────────────────────────────────────
// Grok receives ONLY raw event data — no editorial, no framing
// Its job: identify statistical patterns across events, nothing more

async function analyzeWithGrok(apiKey) {
  const since = Date.now() - 72 * 3600000; // last 72h
  const events = getEvents({ since, limit: 200 });
  const anomalies = events.filter(e => e.anomaly);
  const clusters = clusterAnomalies(events);

  if (!events.length) {
    return {
      error: 'No events collected yet. Wait for first collection cycle to complete.',
      events: 0,
      anomalies: 0,
    };
  }

  // Format raw events for Grok — structured data, no prose
  const eventSummary = events.slice(-100).map(e => {
    const parts = [
      `[${e.source}]`,
      new Date(e.ts).toISOString().slice(0, 16) + 'Z',
      e.type,
      `value=${e.value}${e.unit ? ' ' + e.unit : ''}`,
      e.meta?.zone || e.meta?.place || e.meta?.country || e.meta?.source || '',
      e.anomaly ? `ANOMALY(score=${e.anomaly.score})` : '',
    ];
    return parts.filter(Boolean).join(' | ');
  }).join('\n');

  const clusterSummary = clusters.slice(0, 10).map(c => ({
    sources: c.sources,
    eventCount: c.events.length,
    maxAnomalyScore: c.maxScore,
    timeSpanHours: c.timeSpanHours,
    events: c.events.map(e => `${e.source}:${e.type}:${e.value}${e.unit||''}`),
  }));

  const prompt = `You are analyzing raw sensor and API data for statistical patterns. You have no editorial sources. You do not speculate on intent. You only describe what the numbers show.

RAW EVENT LOG (last 72h):
${eventSummary}

ANOMALY CLUSTERS (events that co-occur within 48h and 500km):
${JSON.stringify(clusterSummary, null, 2)}

STATISTICS:
- Total events: ${events.length}
- Anomalous events: ${anomalies.length}
- Anomaly rate: ${events.length ? ((anomalies.length / events.length) * 100).toFixed(1) : 0}%
- Sources reporting: ${[...new Set(events.map(e => e.source))].join(', ')}

Your task:
1. Identify which signals show statistically significant deviation from baseline
2. Note any co-occurrence of anomalies across different signal types
3. List the raw facts in order of statistical significance
4. DO NOT interpret intent. DO NOT name responsible parties. DO NOT recommend actions.
5. If two different signal types spike simultaneously in the same region, note the co-occurrence as a mathematical fact only.

Return ONLY valid JSON, no markdown:
{
  "composite_anomaly_score": 35,
  "score_basis": "One sentence: what specific numbers drive this score",
  "significant_signals": [
    {
      "source": "SEISMIC|FIRMS|OIL|ADSB|AIS|OFFICIAL|TENDER",
      "observation": "Factual description of what the data shows, numbers only",
      "value": 0,
      "unit": "unit",
      "deviation": "X standard deviations above/below baseline",
      "priority": "HIGH|MED|LOW"
    }
  ],
  "co_occurrences": [
    {
      "sources": ["SOURCE_A", "SOURCE_B"],
      "description": "Factual description of simultaneous deviations, numbers only",
      "region": "geographic area if applicable"
    }
  ],
  "baseline_status": {
    "SEISMIC": "normal|elevated|insufficient_data",
    "FIRMS": "normal|elevated|insufficient_data",
    "OIL": "normal|elevated|insufficient_data",
    "ADSB": "normal|elevated|insufficient_data",
    "AIS": "normal|elevated|insufficient_data",
    "OFFICIAL": "normal|elevated|insufficient_data"
  },
  "data_gaps": ["List any signal types with no data — these are blind spots"]
}`;

  try {
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'grok-3-mini',
        max_tokens: 1500,
        messages: [
          { role: 'system', content: 'You are a signal processing system. Output valid JSON only. Never speculate on human intent. Describe only mathematical observations about the data.' },
          { role: 'user', content: prompt }
        ]
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.choices?.[0]?.message?.content || '{}';
    const analysis = JSON.parse(text.replace(/```json|```/g, '').trim());

    const digest = {
      ...analysis,
      eventCount: events.length,
      anomalyCount: anomalies.length,
      clusterCount: clusters.length,
      sourcesActive: [...new Set(events.map(e => e.source))],
      windowHours: 72,
    };
    saveDigest(digest);
    return digest;
  } catch (e) {
    console.error('[ANALYZER] Error:', e.message);
    return { error: e.message, eventCount: events.length, anomalyCount: anomalies.length };
  }
}

module.exports = { clusterAnomalies, analyzeWithGrok };
