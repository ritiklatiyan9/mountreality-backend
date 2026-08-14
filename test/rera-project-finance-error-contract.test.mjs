import assert from 'node:assert/strict';
import test from 'node:test';

import errorMiddleware from '../src/middlewares/error.middleware.js';

const invoke = (error) => {
  const response = {
    statusCode: null,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
  const previousError = console.error;
  console.error = () => {};
  try {
    errorMiddleware(error, {
      method: 'PUT', originalUrl: '/firms/transactions/7', requestId: 'test-request',
    }, response, () => {});
  } finally {
    console.error = previousError;
  }
  return response;
};

test('retained RERA source conflicts are stable HTTP 409 responses', () => {
  const response = invoke(Object.assign(
    new Error('Reject linked RERA finance controls before changing this bank-entry evidence'),
    { code: '23514' },
  ));
  assert.equal(response.statusCode, 409);
  assert.deepEqual(response.body, {
    message: 'Reject linked RERA finance controls before changing this bank-entry evidence',
    requestId: 'test-request',
    code: 'RERA_CONTROL_CONFLICT',
  });
});

test('unrelated database check violations retain the generic 500 contract', () => {
  const response = invoke(Object.assign(new Error('unrelated internal database detail'), { code: '23514' }));
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.body, {
    message: 'An unexpected server error occurred',
    requestId: 'test-request',
  });
});
