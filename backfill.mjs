// backfill.mjs  —  run once locally to replace sample data with REAL EIA history
// ---------------------------------------------------------------------------
//   node backfill.mjs
//
// Prereqs:
//   • Node 18+ (has global fetch)
//   • An EIA key:      https://www.eia.gov/opendata/  (Register)
//   • An Airtable PAT: https://airtable.com/create/tokens
//        scopes: data.records:read, data.records:write   |  access: this base
//
// Set these three env vars before running, e.g.:
//   EIA_KEY=xxx AIRTABLE_TOKEN=pat_xxx BASE_ID=appwfAVRbXQXFXg2e node backfill.mjs
// ---------------------------------------------------------------------------

const EIA_KEY        = process.env.EIA_KEY;
const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const BASE_ID        = process.env.BASE_ID || 'appwfAVRbXQXFXg2e';
const TABLE          = 'Readings';
const WEEKS          = 52;   // how many weeks of history to load (the chart window)

// Series to load. unit-scale converts EIA's native units to what the base stores.
// VERIFY each id at https://www.eia.gov/opendata/browser/  (Petroleum > Weekly)
const SERIES = [
  { name:'Crude Stocks (ex-SPR)', id:'PET.WCESTUS1.W',              scale:0.001 },
  { name:'Cushing Stocks',        id:'PET.W_EPC0_SAX_YCUOK_MBBL.W', scale:0.001 },
  { name:'Crude Production',      id:'PET.WCRFPUS2.W',              scale:0.001 },
  { name:'Refinery Utilization',  id:'PET.WPULEUS3.W',              scale:1     },
  { name:'Crude Imports',         id:'PET.WCEIMUS2.W',              scale:0.001 },
  { name:'WTI Spot (Cushing)',    id:'PET.RWTC.W',                  scale:1     },
];

// NOTE: EIA stock series are in THOUSAND barrels. If your chart shows ~420000
// instead of ~420, set scale:0.001 on the two stock series. Check one value
// against the EIA site and adjust — getting units right is the whole point.

const eiaUrl = id => `https://api.eia.gov/v2/seriesid/${id}?api_key=${EIA_KEY}`;

async function getSeries(id){
  const r = await fetch(eiaUrl(id));
  if(!r.ok) throw new Error(`EIA ${id} -> ${r.status} ${await r.text()}`);
  const j = await r.json();
  return j.response.data
    .map(d => ({ period:d.period, value:Number(d.value) }))
    .filter(d => Number.isFinite(d.value))
    .sort((a,b) => a.period.localeCompare(b.period));
}

const weekOfYear = p => {
  const d = new Date(p), start = new Date(d.getFullYear(),0,1);
  return Math.floor((d - start) / 6048e5);
};

// build the prior-5-year min/avg/max for the week-of-year of each recent row
function withSeasonal(rows, scale){
  const thisYear = new Date().getFullYear();
  const byWeek = {};
  rows.forEach(r => {
    const y = new Date(r.period).getFullYear();
    if (y >= thisYear-5 && y < thisYear) (byWeek[weekOfYear(r.period)] ||= []).push(r.value*scale);
  });
  const recent = rows.slice(-WEEKS);
  return recent.map((r,i) => {
    const bucket = byWeek[weekOfYear(r.period)] || [r.value*scale];
    return {
      Week: r.period,
      Value: +(r.value*scale).toFixed(1),
      'Prev Value': i>0 ? +(recent[i-1].value*scale).toFixed(1) : +(r.value*scale).toFixed(1),
      'Yr5 Avg': +(bucket.reduce((a,b)=>a+b,0)/bucket.length).toFixed(1),
      'Yr5 Min': +Math.min(...bucket).toFixed(1),
      'Yr5 Max': +Math.max(...bucket).toFixed(1),
    };
  });
}

async function upsert(records){
  // Airtable upsert: merge on the "Key" field so re-runs update instead of duplicate
  const url = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(TABLE)}`;
  for (let i=0; i<records.length; i+=10){            // 10 records per request
    const batch = records.slice(i, i+10);
    const r = await fetch(url, {
      method:'PATCH',
      headers:{ Authorization:`Bearer ${AIRTABLE_TOKEN}`, 'Content-Type':'application/json' },
      body: JSON.stringify({
        performUpsert:{ fieldsToMergeOn:['Key'] },
        typecast:true,
        records: batch.map(f => ({ fields:f })),
      }),
    });
    if(!r.ok) throw new Error(`Airtable -> ${r.status} ${await r.text()}`);
    process.stdout.write('.');
  }
}

(async () => {
  if(!EIA_KEY || !AIRTABLE_TOKEN) throw new Error('Set EIA_KEY and AIRTABLE_TOKEN env vars.');
  const all = [];
  for (const s of SERIES){
    console.log(`\nfetching ${s.name} (${s.id})`);
    const rows = withSeasonal(await getSeries(s.id), s.scale);
    rows.forEach(row => all.push({
      Key: `${s.id}_${row.Week}`,
      Series: [ s.name ],            // typecast:true matches the linked Series by name
      ...row,
    }));
  }
  console.log(`\nupserting ${all.length} readings`);
  await upsert(all);
  console.log('\ndone. refresh Airtable — the sample rows are now real EIA data.');
})();
