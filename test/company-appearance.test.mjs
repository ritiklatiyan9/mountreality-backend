import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const backend = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');
const frontend = (file) => readFile(new URL(`../../Frontend/${file}`, import.meta.url), 'utf8');

test('company appearance preferences are tenant-scoped and admin-published', async () => {
  const [controller, routes, migration] = await Promise.all([
    backend('src/controllers/appearance.controller.js'),
    backend('src/routes/appearance.routes.js'),
    backend('src/migrations/108_company_appearance_preferences.js'),
  ]);
  assert.match(routes, /router\.use\(authMiddleware\)/);
  assert.match(routes, /requireRole\('admin', 'super_admin'\)/);
  assert.match(controller, /organization_id=\$1/);
  assert.match(controller, /DELETE FROM user_appearance_preferences/);
  assert.match(migration, /organization_appearance_settings/);
  assert.match(migration, /user_appearance_preferences/);
  assert.match(migration, /REFERENCES organizations\(id\) ON DELETE CASCADE/);
  assert.match(migration, /CHECK \(theme IN \('light','dark'\)\)/);
});

test('appearance control persists per-user choices and resets to white on logout', async () => {
  const [control, appearance, auth, api, activityCard, html] = await Promise.all([
    frontend('src/components/ui/animated-theme-toggler.jsx'),
    frontend('src/lib/appearance.js'),
    frontend('src/context/AuthContext.jsx'),
    frontend('src/api/api.js'),
    frontend('src/components/ui/activity-card.jsx'),
    frontend('index.html'),
  ]);
  assert.match(control, /\/appearance\/personal/);
  assert.match(control, /\/appearance\/company/);
  assert.match(control, /Apply to company/);
  assert.match(appearance, /resetThemeToWhite/);
  assert.match(auth, /resetThemeToWhite\(\)/);
  assert.match(api, /resetThemeToWhite\(\)/);
  assert.match(activityCard, /resetThemeToWhite\(\)/);
  assert.match(html, /localStorage\.accessToken && localStorage\.theme === 'dark'/);
});
