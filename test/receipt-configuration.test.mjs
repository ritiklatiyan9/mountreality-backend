import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  RECEIPT_CONFIGURATION_DEFAULTS,
  normaliseReceiptConfiguration,
} from '../src/services/receiptConfiguration.service.js';

const source = async (relative) => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

test('receipt configuration is normalized to a stable site contract', () => {
  assert.deepEqual(normaliseReceiptConfiguration(null), RECEIPT_CONFIGURATION_DEFAULTS);
  const config = normaliseReceiptConfiguration({
    template: 'EXECUTIVE', paper_size: 'a5', accent_color: '#4ADE80',
    body_font: 'garamond', heading_font: 'comic-sans', text_scale: 142,
    header_title: '  DIWAN CITY  ', show_remarks: false, show_status: 'false',
    component_order: ['amount', 'header', 'amount', 'invalid'],
    custom_fields: [
      { id: 'plot-zone', label: ' Plot zone ', value: ' Sector 14 ', enabled: true },
      { id: 'plot-zone', label: 'Reference desk', value: 'HQ', enabled: false },
    ],
  });
  assert.equal(config.template, 'executive');
  assert.equal(config.paper_size, 'A5');
  assert.equal(config.accent_color, '#4ade80');
  assert.equal(config.body_font, 'garamond');
  assert.equal(config.heading_font, 'georgia');
  assert.equal(config.text_scale, 130);
  assert.equal(config.header_title, 'DIWAN CITY');
  assert.equal(config.show_remarks, false);
  assert.equal(config.show_status, true, 'non-boolean values cannot silently disable receipt data');
  assert.deepEqual(config.component_order, [
    'amount', 'header', 'document', 'details', 'note', 'signatures', 'footer',
  ]);
  assert.deepEqual(config.custom_fields, [
    { id: 'plot-zone', label: 'Plot zone', value: 'Sector 14', enabled: true },
    { id: 'plot-zone-2', label: 'Reference desk', value: 'HQ', enabled: false },
  ]);
});

test('receipt settings are site-scoped, admin-written, and reusable by site users', async () => {
  const routes = await source('src/routes/applicationSetting.routes.js');
  const service = await source('src/services/receiptConfiguration.service.js');
  assert.match(routes, /router\.get\('\/receipt', authMiddleware, getReceiptConfiguration\)/);
  assert.match(routes, /router\.put\('\/receipt', authMiddleware, requireRole\('admin'\), updateReceiptConfiguration\)/);
  assert.match(service, /applicationSettingModel\.getJson\(siteId/);
  assert.match(service, /applicationSettingModel\.setJson\(siteId/);
});

test('land and plot payment screens use the same configurable receipt engine', async () => {
  const [land, plot, settings, app, settingsPage, printer, preview] = await Promise.all([
    source('../Frontend/src/pages/LandAcquisitionDetail.jsx'),
    source('../Frontend/src/pages/PlotDetail.jsx'),
    source('../Frontend/src/components/settings/ReceiptSettings.jsx'),
    source('../Frontend/src/App.jsx'),
    source('../Frontend/src/pages/Settings.jsx'),
    source('../Frontend/src/lib/printReceipt.js'),
    source('../Frontend/src/components/receipts/UnifiedReceiptPreview.jsx'),
  ]);
  assert.match(land, /onPrint=\{printTransactionReceipt\}/);
  assert.match(land, /<ReceiptText className="h-4 w-4"/);
  assert.match(land, /printUnifiedReceipt\(\{/);
  assert.match(plot, /printUnifiedReceipt\(\{/);
  assert.match(land, /configuration: receiptConfiguration/);
  assert.match(plot, /configuration: \{ \.\.\.receiptConfiguration, show_verification_qr: false \}/);
  assert.match(settings, /UnifiedReceiptPreview/);
  assert.match(settings, /updateReceiptConfiguration/);
  assert.match(settings, /DndContext/);
  assert.match(settings, /SortableContext/);
  assert.match(settings, /Custom receipt fields/);
  assert.match(settings, /RECEIPT_FONT_OPTIONS/);
  assert.match(settings, /Full receipt preview/);
  assert.match(app, /path="\/settings\/receipt"/);
  assert.match(settingsPage, /navigate\("\/settings\/receipt"/);
  assert.match(printer, /configuration\.component_order/);
  assert.match(printer, /configuration\.custom_fields/);
  assert.match(printer, /RECEIPT_FONT_STACKS/);
  assert.match(preview, /ResizeObserver/);
});
