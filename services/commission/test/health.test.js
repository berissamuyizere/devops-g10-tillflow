const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../src/app');

describe('commission probes', () => {
  it('serves /health /ready /version', async () => {
    const app = createApp();
    const health = await request(app).get('/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.service, 'commission');
    const ready = await request(app).get('/ready');
    assert.equal(ready.status, 200);
    const version = await request(app).get('/version');
    assert.equal(version.status, 200);
    assert.equal(version.body.service, 'commission');
  });
});
