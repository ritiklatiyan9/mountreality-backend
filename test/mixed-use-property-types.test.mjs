import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  inventoryPropertyTypesForShape,
  normalizeInventoryPropertyType,
} from '../src/services/sitePolicy.service.js';

test('mixed-use profiles allow every supported inventory property type', () => {
  assert.deepEqual(inventoryPropertyTypesForShape('MIXED_USE'), [
    'PLOT', 'APARTMENT', 'SHOP', 'OFFICE', 'VILLA', 'OTHER',
  ]);
  assert.equal(
    normalizeInventoryPropertyType({ value: 'apartment', projectShape: 'MIXED_USE' }),
    'APARTMENT',
  );
});

test('single-shape profiles reject incompatible property types', () => {
  assert.equal(
    normalizeInventoryPropertyType({ projectShape: 'APARTMENT' }),
    'APARTMENT',
  );
  assert.throws(
    () => normalizeInventoryPropertyType({ value: 'SHOP', projectShape: 'APARTMENT' }),
    (error) => error.code === 'PROPERTY_TYPE_NOT_ALLOWED' && error.statusCode === 422,
  );
});

test('migration and write paths persist the property classification', () => {
  const migration = fs.readFileSync(new URL('../src/migrations/126_mixed_use_property_types.js', import.meta.url), 'utf8');
  const controller = fs.readFileSync(new URL('../src/controllers/plot.controller.js', import.meta.url), 'utf8');
  const graphql = fs.readFileSync(new URL('../src/graphql/schema.js', import.meta.url), 'utf8');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS property_type/);
  assert.match(migration, /idx_plots_site_property_type/);
  assert.match(controller, /property_type: normalizedPropertyType/);
  assert.match(graphql, /property_type:\s+\{ type: GraphQLString \}/);
});
