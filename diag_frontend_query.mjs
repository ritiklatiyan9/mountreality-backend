import 'dotenv/config';
import jwt from 'jsonwebtoken';

// Simulate EXACT frontend "overall" range
const now = new Date();
const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
const range = { start: '2000-01-01', end: end.toISOString().slice(0, 10) };
console.log('Range:', range);

const token = jwt.sign({ id: 1, role: 'admin', site_id: 5 }, process.env.JWT_ACCESS_SECRET, { expiresIn: '1h' });
const query = JSON.stringify({
  query: `query GetKpiCards($siteId: ID!, $range: DateRange!, $excludeOldPlots: Boolean) {
    kpiCards(siteId: $siteId, range: $range, excludeOldPlots: $excludeOldPlots) {
      totalRevenue totalExpense netProfit profitMargin outstanding cashflow
      breakdown { module debit credit count }
      cashflowDetail { incoming outgoing net }
      outstandingDetail { given returned pending }
    }
  }`,
  variables: { siteId: "5", range, excludeOldPlots: false }
});

const resp = await fetch('http://localhost:80000/graphql', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  body: query,
});
const data = await resp.json();
if (data.errors) {
  console.log('ERRORS:', JSON.stringify(data.errors, null, 2));
} else {
  console.log('RESPONSE:', JSON.stringify(data.data.kpiCards, null, 2));
}
process.exit(0);
