// weekly-read.mjs
// Runs via GitHub Actions every Thursday.
// Reads the latest week from Airtable, asks Gemini to write the analyst note,
// writes a new Weekly Read record back.
// -----------------------------------------------------------------
// Required GitHub secrets:
//   AIRTABLE_TOKEN  — a PAT with data.records:read + data.records:write on this base
//   GEMINI_KEY      — free key from https://aistudio.google.com/apikey
// -----------------------------------------------------------------

const BASE_ID        = 'appwfAVRbXQXFXg2e';
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const GEMINI_KEY     = process.env.GEMINI_KEY;
const GEMINI_MODEL   = 'gemini-2.0-flash'; // update if AI Studio shows a newer model

if (!AIRTABLE_TOKEN || !GEMINI_KEY) {
  console.error('Missing AIRTABLE_TOKEN or GEMINI_KEY env vars.');
  process.exit(1);
}

// Table IDs (from the base we built)
const T = {
  series:      'tbl9m05yz2yFDd3h5',
  readings:    'tbl78uiOZwfIWBxlw',
  disruptions: 'tblVmtaz2KtrbhS4v',
  weeklyReads: 'tblRPkRqdI7cGC2Cf',
};

// Field IDs
const F = {
  // Series
  seriesName:       'fldO6sfJZU2OIURdA',
  // Readings
  readingKey:       'fldIaPdZbMXvpcSmK',
  readingWeek:      'fldOi7Ln6VGvOd0It',
  readingValue:     'fldxEiOW1t6cprF81',
  readingSeries:    'fldp2iWfVzRvCTfxF',
  readingWoW:       'fldvushReDYeLM5jw',
  readingPctSeas:   'fldIeMJ2ziebnfBhq',
  readingFlag:      'fld8T8alcOJyBGBEx',
  // Disruptions
  dispTitle:        'fldcHP5xMSF5iggeT',
  dispDate:         'fldkpd2cUNdTtyebq',
  dispType:         'fld7JOk7u9sWVWI9j',
  dispRegion:       'fldcli3X9GF7A8Yvp',
  dispSeverity:     'fldP1iX3HtaIopyKe',
  dispNote:         'fldFU4twasn4Nz5Wv',
  // Weekly Reads
  wrTitle:          'fldw7VqbcfeA3mYY5',
  wrWeekOf:         'fldWP25oIVFMOAvvw',
  wrSignal:         'fldlDVPVuXGfdtF7q',
  wrSummary:        'fldgGEZEPxHEB9FNz',
  wrGeneratedBy:    'fld7ryjXCkKZbocY5',
  wrReadings:       'fldGkGg0Sfgmy0sgp',
  wrDisruptions:    'fld8q6uD3M50WUXbT',
};

// ---- Airtable REST helper -----------------------------------------------
async function at(tableId, params = {}, method = 'GET', body = null) {
  const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${tableId}`);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach(i => url.searchParams.append(k, i));
    else url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : null,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Airtable ${method} ${tableId} -> ${res.status}: ${txt}`);
  }
  return res.json();
}

// Fetch all records across pages
async function fetchAll(tableId, params = {}) {
  const records = [];
  let offset;
  do {
    const p = offset ? { ...params, offset } : params;
    const data = await at(tableId, p);
    records.push(...data.records);
    offset = data.offset;
  } while (offset);
  return records;
}

// Linked record field → first record ID (handles both ['recXXX'] and [{id:'recXXX'}])
const firstId = val =>
  Array.isArray(val) && val.length
    ? (typeof val[0] === 'string' ? val[0] : val[0].id)
    : null;

// ---- 1. Load Series names ------------------------------------------------
console.log('Loading series...');
const seriesRecords = await fetchAll(T.series, {
  'fields[]': [F.seriesName],
});
const seriesMap = Object.fromEntries(
  seriesRecords.map(r => [r.id, r.fields[F.seriesName]])
);
// Also build a name→id map so we can find Crude Stocks without hardcoding its recId
const seriesIdByName = Object.fromEntries(
  Object.entries(seriesMap).map(([id, name]) => [name, id])
);

// ---- 2. Load all Readings; find the latest week -------------------------
console.log('Loading readings...');
const allReadings = await fetchAll(T.readings, {
  'fields[]': [
    F.readingKey, F.readingWeek, F.readingValue,
    F.readingSeries, F.readingWoW, F.readingPctSeas, F.readingFlag,
  ],
});

const latestWeek = allReadings
  .map(r => r.fields[F.readingWeek])
  .filter(Boolean)
  .sort()
  .at(-1);
if (!latestWeek) throw new Error('No readings found in the base.');
console.log(`Latest week: ${latestWeek}`);

const latestRows = allReadings.filter(r => r.fields[F.readingWeek] === latestWeek);

// ---- 3. Derive signal from Crude Stocks seasonal deviation ---------------
//   Signal is computed from the REAL number, not guessed by the model.
const crudeStocksId = seriesIdByName['Crude Stocks (ex-SPR)'];
const stocksRow = latestRows.find(r => firstId(r.fields[F.readingSeries]) === crudeStocksId);
const pct = stocksRow?.fields[F.readingPctSeas] ?? 0;
const signal = pct < -2 ? 'Tight' : pct > 2 ? 'Loose' : 'Balanced';
console.log(`Signal: ${signal} (crude stocks ${pct}% vs 5-yr avg)`);

// ---- 4. Load recent disruptions (last 12 days) ---------------------------
const cutoff = new Date();
cutoff.setDate(cutoff.getDate() - 12);
const cutoffStr = cutoff.toISOString().split('T')[0];

const recentDisruptions = await fetchAll(T.disruptions, {
  'fields[]': [F.dispTitle, F.dispDate, F.dispType, F.dispRegion, F.dispSeverity, F.dispNote],
  filterByFormula: `IS_AFTER({${F.dispDate}}, '${cutoffStr}')`,
});
console.log(`Disruptions in last 12 days: ${recentDisruptions.length}`);

// ---- 5. Build the prompt --------------------------------------------------
const facts = latestRows.map(r => {
  const name = seriesMap[firstId(r.fields[F.readingSeries])] || r.fields[F.readingKey];
  const val  = r.fields[F.readingValue];
  const ps   = r.fields[F.readingPctSeas];
  const wow  = r.fields[F.readingWoW];
  return `- ${name}: ${val} (${ps}% vs 5-yr avg, WoW ${wow >= 0 ? '+' : ''}${wow})`;
}).join('\n');

const events = recentDisruptions.length
  ? recentDisruptions.map(d => {
      const f = d.fields;
      return `- ${f[F.dispDate]} [${f[F.dispType]}/${f[F.dispSeverity]}] ${f[F.dispTitle]}: ${f[F.dispNote]}`;
    }).join('\n')
  : '- none logged this week';

const prompt =
`You are a commodities desk analyst writing the weekly U.S. crude oil read.
Write 3-4 sentences. Factual, concise, in the voice of a sober desk note.
Use ONLY the numbers and events provided below — do not invent anything.
The market signal has already been determined as "${signal}" from the data — be consistent with it.

THIS WEEK (${latestWeek}):
${facts}

LOGGED DISRUPTIONS:
${events}

Write the read now (prose only, no headings, no bullet points, no preamble):`;

// ---- 6. Call Gemini -------------------------------------------------------
console.log('Calling Gemini...');
const gemRes = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  }
);
if (!gemRes.ok) {
  const t = await gemRes.text();
  throw new Error(`Gemini -> ${gemRes.status}: ${t}`);
}
const gemData = await gemRes.json();
const summary = gemData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
if (!summary) throw new Error('Gemini returned no text. Check the model name and API key.');
console.log('Summary generated.');

// ---- 7. Write the Weekly Read to Airtable ---------------------------------
const d     = new Date(latestWeek);
const title = `Week of ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

await at(T.weeklyReads, {}, 'POST', {
  typecast: true,
  records: [{
    fields: {
      [F.wrTitle]:       title,
      [F.wrWeekOf]:      latestWeek,
      [F.wrSignal]:      signal,
      [F.wrSummary]:     summary,
      [F.wrGeneratedBy]: 'AI',
      [F.wrReadings]:    latestRows.map(r => r.id),
      [F.wrDisruptions]: recentDisruptions.map(r => r.id),
    },
  }],
});

console.log(`\nDone. Created "${title}" — signal: ${signal}`);
console.log(`\nSummary:\n${summary}`);
