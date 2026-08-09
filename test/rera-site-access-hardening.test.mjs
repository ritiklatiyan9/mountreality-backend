import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('entity Site enforcement reconciles context before tenant and policy checks', async () => {
  const text = await source('src/utils/siteAccessPolicy.js');
  const mismatchAt = text.indexOf('selectedSiteId !== resolvedSiteId');
  const tenantAt = text.indexOf('organization_id = $2');
  const policyAt = text.lastIndexOf('isSiteModuleAllowed');
  assert.ok(mismatchAt > 0);
  assert.ok(tenantAt > mismatchAt);
  assert.ok(policyAt > tenantAt);
  assert.match(text, /req\.siteContextId = resolvedSiteId/);
  assert.match(text, /SITE_CONTEXT_MISMATCH/);
  assert.match(text, /SITE_POLICY_DENIED/);
});

test('plot access applies plot_payments policy to the entity-derived Site', async () => {
  const text = await source('src/middlewares/plotSiteAccess.middleware.js');
  assert.match(text, /enforceEntitySiteAccess/);
  assert.match(text, /module: 'plot_payments'/);
  assert.match(text, /contextProperty: 'plotSiteId'/);
});

test('registry access covers records, source payments, plots, and documents', async () => {
  const [middleware, routes] = await Promise.all([
    source('src/middlewares/registrySiteAccess.middleware.js'),
    source('src/routes/registry.routes.js'),
  ]);
  assert.match(middleware, /module: 'plot_registry'/);
  assert.match(middleware, /document: `SELECT COALESCE/);
  assert.match(routes, /accessByParamDocument/);
  assert.match(routes, /delete\('\/documents\/:docId'[\s\S]*accessByParamDocument/);
});

test('imprest access applies policy after resolving the actual Site', async () => {
  const text = await source('src/middlewares/imprestSiteAccess.middleware.js');
  assert.match(text, /enforceEntitySiteAccess/);
  assert.match(text, /module: 'imprest'/);
  assert.match(text, /contextProperty: 'imprestSiteId'/);
  assert.match(text, /JOIN sites s ON s\.id = \$2 AND s\.organization_id = u\.organization_id/);
});

test('farmer middleware resolves single and bulk entity IDs to one Site', async () => {
  const text = await source('src/middlewares/farmerSiteAccess.middleware.js');
  assert.match(text, /farmer_payments fp[\s\S]*JOIN farmers f/);
  assert.match(text, /SELECT DISTINCT site_id FROM farmers WHERE id = ANY/);
  assert.match(text, /MULTIPLE_SITE_CONTEXTS/);
  assert.match(text, /module: 'farmers'/);
});

test('every Farmer API data route establishes Site access and permission', async () => {
  const text = await source('src/routes/farmer.routes.js');
  const routeLines = text.split('\n').filter((line) => line.trim().startsWith('router.')
    && !line.includes('router.use')
    && !line.includes("'/verify-receipt'"));
  assert.ok(routeLines.length >= 11);
  for (const line of routeLines) {
    assert.match(line, /accessBy/);
    assert.match(line, /requirePermission\('farmers'/);
    assert.ok(line.indexOf('accessBy') < line.indexOf('requirePermission'));
  }
});

test('Farmer reads and writes are scoped by Site and organization in SQL', async () => {
  const [controller, model] = await Promise.all([
    source('src/controllers/farmer.controller.js'),
    source('src/models/Farmer.model.js'),
  ]);
  assert.match(controller, /findBySiteIdScoped/);
  assert.match(controller, /findByIdWithSummaryScoped/);
  assert.match(controller, /updateScoped/);
  assert.match(controller, /DELETE FROM farmers f[\s\S]*s\.organization_id = \$3/);
  assert.match(model, /JOIN sites s ON s\.id = f\.site_id AND s\.organization_id/);
});

test('Farmer payment deletes scope Day Book cleanup to an authorized target CTE', async () => {
  const text = await source('src/controllers/farmer.controller.js');
  const targetCtes = text.match(/WITH target AS \(/g) || [];
  assert.equal(targetCtes.length, 2);
  assert.match(text, /JOIN sites s ON s\.id = f\.site_id AND s\.organization_id = \$4/);
  assert.doesNotMatch(text, /DELETE FROM day_book WHERE farmer_payment_id = ANY/);
});

test('Farmer member and payment references cannot cross the canonical Site', async () => {
  const text = await source('src/controllers/farmer.controller.js');
  assert.match(text, /memberBelongsToSite/);
  assert.match(text, /userAvailableForSite/);
  assert.match(text, /m\.site_id = \$1 AND m\.member_type = 'FARMER'/);
  assert.match(text, /s\.organization_id = \$2/);
});

test('plot-document routes resolve the actual Site before permission and upload buffering', async () => {
  const text = await source('src/routes/plotDocument.routes.js');
  const routeLines = text.split('\n').filter((line) => line.trim().startsWith('router.')
    && !line.includes('router.use'));
  assert.equal(routeLines.length, 4);
  for (const line of routeLines) {
    assert.match(line, /accessBy/);
    assert.match(line, /requirePermission\('plot_payments'/);
    assert.ok(line.indexOf('accessBy') < line.indexOf('requirePermission'));
  }
  const uploadRoute = routeLines.find((line) => line.includes("post('/:plotId'"));
  assert.ok(uploadRoute.indexOf('accessByPlot') < uploadRoute.indexOf('receivePlotDocument'));
  assert.match(text, /entity: 'document'/);
  assert.match(text, /module: 'plot_payments'/);
});

test('plot-document controller SQL independently scopes reads and deletes by tenant and Site', async () => {
  const text = await source('src/controllers/plotDocument.controller.js');
  assert.doesNotMatch(text, /const ensureSiteAccess/);
  assert.match(text, /s\.organization_id = \$3/);
  assert.match(text, /p\.site_id = \$2/);
  assert.match(text, /DELETE FROM documents target[\s\S]*scope_site\.organization_id = \$3/);
  assert.match(text, /\(d\.site_id IS NULL OR d\.site_id = \$2\)/);
  assert.match(text, /\(b\.site_id IS NULL OR b\.site_id = \$2\)/);
});

test('commission entity middleware resolves classic, V2, plot, payment and bulk Sites', async () => {
  const text = await source('src/middlewares/commissionSiteAccess.middleware.js');
  assert.match(text, /commission: 'SELECT site_id FROM plot_commissions/);
  assert.match(text, /master: 'SELECT site_id FROM plot_commissions_v2/);
  assert.match(text, /plot_commission_payments pcp[\s\S]*JOIN plot_commissions_v2 pc/);
  assert.match(text, /MULTIPLE_SITE_CONTEXTS/);
  assert.match(text, /module: 'commissions'/);
});

test('classic and V2 commission routes derive Site before permission checks', async () => {
  for (const file of ['src/routes/commission.routes.js', 'src/routes/plotCommissionV2.routes.js']) {
    const text = await source(file);
    const routeLines = text.split('\n').filter((line) => line.trim().startsWith('router.')
      && !line.includes('router.use'));
    assert.ok(routeLines.length >= 6);
    for (const line of routeLines) {
      assert.match(line, /accessBy/);
      assert.match(line, /requirePermission\('commissions'/);
      assert.ok(line.indexOf('accessBy') < line.indexOf('requirePermission'));
    }
  }
});

test('commission ID reads and mutations retain Site and organization predicates', async () => {
  const [classicController, classicModel, v2Controller, v2Model] = await Promise.all([
    source('src/controllers/commission.controller.js'),
    source('src/models/PlotCommission.model.js'),
    source('src/controllers/plotCommissionV2.controller.js'),
    source('src/models/PlotCommissionV2.model.js'),
  ]);
  assert.match(classicController, /findByIdScoped/);
  assert.match(classicController, /deleteScoped/);
  assert.match(classicModel, /pc\.site_id = \$2[\s\S]*s\.organization_id = \$3/);
  assert.match(v2Controller, /DELETE FROM plot_commission_payments pcp[\s\S]*s\.organization_id = \$3/);
  assert.match(v2Controller, /UPDATE plot_commission_payments pcp[\s\S]*s\.organization_id/);
  assert.match(v2Model, /pc\.id = \$1 AND pc\.site_id = \$2/);
  assert.match(v2Model, /s\.organization_id = \$3/);
});

test('construction resolver derives Site for projects, tasks, and material requests', async () => {
  const text = await source('src/middlewares/constructionSiteAccess.middleware.js');
  assert.match(text, /project: 'SELECT site_id FROM construction_projects/);
  assert.match(text, /construction_tasks t[\s\S]*JOIN construction_projects p/);
  assert.match(text, /request: 'SELECT site_id FROM construction_material_requests/);
  assert.match(text, /module: 'construction'/);
  assert.match(text, /contextProperty: 'constructionSiteId'/);
});

test('every construction route resolves actual Site before permission', async () => {
  const text = await source('src/routes/construction.routes.js');
  const routeLines = text.split('\n').filter((line) => line.trim().startsWith('router.')
    && !line.includes('router.use'));
  assert.equal(routeLines.length, 14);
  for (const line of routeLines) {
    assert.match(line, /accessBy/);
    assert.match(line, /requirePermission\('construction'/);
    assert.ok(line.indexOf('accessBy') < line.indexOf('requirePermission'));
  }
});

test('construction ID reads and mutations are Site and organization scoped', async () => {
  const text = await source('src/controllers/construction.controller.js');
  assert.doesNotMatch(text, /UPDATE construction_projects SET[\s\S]*WHERE id =/);
  assert.doesNotMatch(text, /DELETE FROM construction_projects WHERE id =/);
  assert.doesNotMatch(text, /UPDATE construction_tasks SET[\s\S]*WHERE id =/);
  assert.doesNotMatch(text, /DELETE FROM construction_tasks WHERE id =/);
  assert.match(text, /UPDATE construction_projects p[\s\S]*p\.site_id = \$\$\{siteIndex\}/);
  assert.match(text, /DELETE FROM construction_tasks t[\s\S]*s\.organization_id = \$3/);
  assert.match(text, /construction_material_requests r[\s\S]*s\.organization_id/);
  assert.match(text, /Task does not belong to this project/);
});
