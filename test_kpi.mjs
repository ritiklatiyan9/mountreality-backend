import 'dotenv/config';
import { getAllKpis } from './src/graphql/services/kpi.service.js';

const siteId = 5;
const start = '2000-01-01';
const end = '2026-12-31';

try {
  console.log('Testing KPI service...');
  const result = await getAllKpis(siteId, start, end, false);
  console.log('Result:', JSON.stringify(result, null, 2));
} catch (err) {
  console.error('ERROR:', err.message);
  console.error(err.stack);
}
process.exit(0);
