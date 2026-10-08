import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildPlan, runPlan, parseArgs } from '../scripts/import.mjs';

/** A stand-in for Make's API that records each call and answers like the documented routes. */
const startFakeMake = async () => {
  const calls = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      calls.push({ method: request.method, url: request.url, headers: request.headers, body });
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'POST' && request.url === '/api/v2/sdk/apps') {
        response.end(JSON.stringify({ app: { name: 'looot-x1y2z3', label: 'looot', version: 1 } }));
      } else if (request.method === 'POST' && request.url.endsWith('/connections')) {
        response.end(JSON.stringify({ appConnection: { name: 'looot-x1y2z3-conn', label: 'looot', type: 'basic' } }));
      } else if (request.url.includes('/modules/boom')) {
        response.statusCode = 400;
        response.end(JSON.stringify({ message: 'bad module' }));
      } else {
        response.end(JSON.stringify({ change: {} }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { calls, baseUrl: `http://127.0.0.1:${server.address().port}/api/v2`, close: () => new Promise((resolve) => server.close(resolve)) };
};

test('the plan has 68 calls and a dry run sends none', async () => {
  const steps = await buildPlan();
  assert.equal(steps.length, 68);
  const lines = [];
  await runPlan(steps, { baseUrl: 'https://eu1.make.com/api/v2', apply: false, log: (line) => lines.push(line) });
  assert.equal(lines.length, 68);
  assert.match(lines[0], /^POST https:\/\/eu1\.make\.com\/api\/v2\/sdk\/apps {2}\(create app\)$/);
});

test('apply creates the app, the connection and every module with the names Make returns', async () => {
  const fake = await startFakeMake();
  try {
    const steps = await buildPlan();
    const names = await runPlan(steps, { baseUrl: fake.baseUrl, token: 'make-token', apply: true, log: () => {} });
    assert.equal(names.app, 'looot-x1y2z3');
    assert.equal(fake.calls.length, 68);
    assert.ok(fake.calls.every((call) => call.headers.authorization === 'Token make-token'));

    const createApp = JSON.parse(fake.calls[0].body);
    assert.equal(createApp.name, 'looot');
    assert.equal(createApp.audience, 'global');

    assert.equal(fake.calls[1].url, '/api/v2/sdk/apps/looot-x1y2z3/connections');
    assert.deepEqual(JSON.parse(fake.calls[1].body), { type: 'basic', label: 'looot' });
    assert.equal(fake.calls[2].url, '/api/v2/sdk/apps/connections/looot-x1y2z3-conn/api');
    assert.equal(fake.calls[2].headers['content-type'], 'application/jsonc');
    assert.equal(fake.calls[4].url, '/api/v2/sdk/apps/looot-x1y2z3/1/base');

    const moduleCreates = fake.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/1/modules')).map((call) => JSON.parse(call.body));
    assert.equal(moduleCreates.length, 10);
    assert.ok(moduleCreates.every((module) => module.connection === 'looot-x1y2z3-conn' && module.moduleInitMode === 'blank'));
    const typeIds = Object.fromEntries(moduleCreates.map((module) => [module.name, module.typeId]));
    assert.equal(typeIds.findWorkEmail, 4);
    assert.equal(typeIds.searchCatalog, 9);
    assert.equal(typeIds.watchFinishedRuns, 1);
    assert.equal(typeIds.makeApiCall, 12);
    assert.equal(moduleCreates.find((module) => module.name === 'makeApiCall').subtype, 'Universal');

    const sections = fake.calls.filter((call) => call.url.includes('/modules/watchFinishedRuns/')).map((call) => call.url.split('/').pop());
    assert.deepEqual(sections, ['api', 'epoch', 'parameters', 'expect', 'interface', 'samples']);
    assert.equal(fake.calls.at(-2).url, '/api/v2/sdk/apps/looot-x1y2z3/1/groups');
    assert.equal(fake.calls.at(-1).url, '/api/v2/sdk/apps/looot-x1y2z3/1/readme');
    assert.equal(fake.calls.at(-1).headers['content-type'], 'text/markdown');
  } finally {
    await fake.close();
  }
});

test('--app deploys into an existing app without creating one', async () => {
  const fake = await startFakeMake();
  try {
    const steps = await buildPlan({ existingApp: 'my-looot' });
    assert.equal(steps.length, 67);
    await runPlan(steps, { baseUrl: fake.baseUrl, token: 't', existingApp: 'my-looot', apply: true, log: () => {} });
    assert.equal(fake.calls[0].url, '/api/v2/sdk/apps/my-looot/connections');
  } finally {
    await fake.close();
  }
});

test('a refused call stops the import and names the step', async () => {
  const fake = await startFakeMake();
  try {
    const steps = [
      { label: 'create module boom', method: 'POST', path: () => '/sdk/apps/a/1/modules/boom', json: () => ({}) },
      { label: 'never sent', method: 'PUT', path: () => '/sdk/apps/a/1/base', text: '{}', contentType: 'application/jsonc' },
    ];
    await assert.rejects(runPlan(steps, { baseUrl: fake.baseUrl, token: 't', apply: true, log: () => {} }), /create module boom failed.*HTTP 400/);
    assert.equal(fake.calls.length, 1);
  } finally {
    await fake.close();
  }
});

test('parseArgs reads the flags and refuses unknown ones', () => {
  assert.deepEqual(parseArgs(['--apply', '--app', 'x']), { apply: true, app: 'x', name: 'looot' });
  assert.throws(() => parseArgs(['--nope']), /Unknown option/);
});
