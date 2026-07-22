import jwt from 'jsonwebtoken';
import 'dotenv/config';

const token = jwt.sign({ id: 1, role: 'admin', site_id: 5 }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' });

const query = JSON.stringify({
  query: `{ kpiCards(siteId: "5", range: { start: "2000-01-01", end: "2026-12-31" }, skipCache: true) { outstanding outstandingDetail { given returned pending } } }`
});

const resp = await fetch('https://rgaccountbackend.onrender.com0/graphql', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  body: query,
});
const data = await resp.json();
console.log(JSON.stringify(data, null, 2));
process.exit(0);
