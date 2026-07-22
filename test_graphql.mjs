import 'dotenv/config';
import { createSign } from 'crypto';
import jwt from 'jsonwebtoken';

// Create a test token
const token = jwt.sign(
  { id: 1, role: 'admin', site_id: 5 },
  process.env.JWT_ACCESS_SECRET,
  { expiresIn: '1h' }
);

const query = JSON.stringify({
  query: `query { kpiCards(siteId: "5", range: { start: "2000-01-01", end: "2026-12-31" }) { totalRevenue totalExpense netProfit } }`
});

const resp = await fetch('https://rgaccountbackend.onrender.com0/graphql', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  },
  body: query,
});

const data = await resp.json();
console.log('Status:', resp.status);
console.log('Response:', JSON.stringify(data, null, 2));
process.exit(0);
