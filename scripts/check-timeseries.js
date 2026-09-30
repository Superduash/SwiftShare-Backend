require('dotenv').config();
const mongoose = require('mongoose');
const PageView = require('../models/PageView');

async function test() {
  await mongoose.connect(process.env.MONGODB_URI);
  const agg = await PageView.aggregate([
    { $match: { isBot: false } },
    { $group: { _id: { $dateTrunc: { date: '$ts', unit: 'day', timezone: 'Asia/Kolkata' } }, v: { $sum: 1 } } },
    { $sort: { _id: 1 } }
  ]);
  console.log('MongoDB Aggregation output:', agg);
  await mongoose.disconnect();
}
test().catch(console.error);
