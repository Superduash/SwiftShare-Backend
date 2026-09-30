require('dotenv').config();
const mongoose = require('mongoose');

async function testRanges() {
  await mongoose.connect(process.env.MONGODB_URI);
  const { getTimeseries, getOverviewStats } = require('../services/adminAnalytics');
  
  const ranges = ['24h', '7d', '30d', '90d', 'all'];
  const metrics = ['pageviews', 'visitors', 'transfers', 'downloads', 'bytes', 'crawlerHits'];

  console.log('=== TESTING ALL OVERVIEWS ===');
  for (const r of ranges) {
    const ov = await getOverviewStats(r);
    console.log(`Overview [${r}]: PV=${ov.kpis.pageviews.value}, Visitors=${ov.kpis.visitors.value}, Bots=${ov.kpis.crawlerHits.value}`);
  }

  console.log('\n=== TESTING ALL TIMESERIES ===');
  for (const r of ranges) {
    for (const m of metrics) {
      const ts = await getTimeseries(m, r);
      const sum = (ts.series || []).reduce((acc, pt) => acc + pt.v, 0);
      console.log(`Timeseries [${r} - ${m}]: count=${ts.series?.length}, sum=${sum}`);
    }
  }

  await mongoose.disconnect();
}
testRanges().catch(console.error);
