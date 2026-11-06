import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildPlan, runPlan, readBack, parseArgs } from '../scripts/import.mjs';

/** A stand-in for Make's API that records each call and answers like the documented routes. */
const startFakeMake = async () => {
  const calls = [];
  const stored = new Map();
  const lists = {
    '/api/v2/sdk/apps/my-looot/connections': { appConnections: [{ name: 'my-looot', label: 'looot', type: 'basic' }] },
    '/api/v2/sdk/apps/my-looot/1/modules': { appModules: [{ name: 'findWorkEmail' }, { name: 'getBalance' }] },
    '/api/v2/sdk/apps/my-looot/1/rpcs': { appRpcs: [{ name: 'listRuns' }] },
    '/api/v2/sdk/apps/my-looot/1/functions': { appFunctions: [] },
  };
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      calls.push({ method: request.method, url: request.url, headers: request.headers, body });
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'PUT') stored.set(request.url, body);
      if (request.method === 'GET') {
        response.end(lists[request.url] ? JSON.stringify(lists[request.url]) : stored.get(request.url) ?? '{}');
        return;
      }
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
  return { calls, stored, baseUrl: `http://127.0.0.1:${server.address().port}/api/v2`, close: () => new Promise((resolve) => server.close(resolve)) };
};

test('the plan has 77 calls and a dry run sends none', async () => {
  const steps = await buildPlan();
  assert.equal(steps.length, 77);
  const lines = [];
  await runPlan(steps, { baseUrl: 'https://eu1.make.com/api/v2', apply: false, log: (line) => lines.push(line) });
  assert.equal(lines.length, 77);
  assert.match(lines[0], /^POST https:\/\/eu1\.make\.com\/api\/v2\/sdk\/apps {2}\(create app\)$/);
});

test('apply creates the app, the connection and every module with the names Make returns', async () => {
  const fake = await startFakeMake();
  try {
    const steps = await buildPlan();
    const names = await runPlan(steps, { baseUrl: fake.baseUrl, token: 'make-token', apply: true, log: () => {} });
    assert.equal(names.app, 'looot-x1y2z3');
    assert.equal(fake.calls.length, 77);
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

    const rpcCreates = fake.calls.filter((call) => call.method === 'POST' && call.url.endsWith('/1/rpcs')).map((call) => JSON.parse(call.body));
    assert.deepEqual(rpcCreates.map((rpc) => rpc.name), ['listOperations', 'listRuns', 'operationInputFields']);
    assert.ok(rpcCreates.every((rpc) => rpc.connection === 'looot-x1y2z3-conn'));
    const firstModule = fake.calls.findIndex((call) => call.url.endsWith('/1/modules'));
    assert.ok(fake.calls.findIndex((call) => call.url.endsWith('/1/rpcs')) < firstModule, 'RPCs exist before the modules that use them');

    const sections = fake.calls.filter((call) => call.url.includes('/modules/watchFinishedRuns/')).map((call) => call.url.split('/').pop());
    assert.deepEqual(sections, ['api', 'epoch', 'parameters', 'expect', 'interface', 'samples']);
    assert.equal(fake.calls.at(-2).url, '/api/v2/sdk/apps/looot-x1y2z3/1/groups');
    assert.equal(fake.calls.at(-1).url, '/api/v2/sdk/apps/looot-x1y2z3/1/readme');
    assert.equal(fake.calls.at(-1).headers['content-type'], 'text/markdown');
  } finally {
    await fake.close();
  }
});

test('--app updates an existing app: reuses its connection, patches existing modules, then reads every section back', async () => {
  const fake = await startFakeMake();
  try {
    const steps = await buildPlan({ existingApp: 'my-looot' });
    assert.equal(steps.length, 76);
    const lines = [];
    const names = await runPlan(steps, { baseUrl: fake.baseUrl, token: 't', existingApp: 'my-looot', apply: true, log: (line) => lines.push(line) });
    assert.equal(names.connections.looot, 'my-looot');
    assert.ok(!fake.calls.some((call) => call.method === 'POST' && call.url.endsWith('/connections')), 'no second connection');
    assert.ok(fake.calls.some((call) => call.url === '/api/v2/sdk/apps/connections/my-looot/api' && call.method === 'PUT'));
    const patch = fake.calls.find((call) => call.method === 'PATCH');
    assert.equal(patch.url, '/api/v2/sdk/apps/my-looot/1/modules/findWorkEmail');
    assert.deepEqual(Object.keys(JSON.parse(patch.body)), ['label', 'description']);
    const created = fake.calls.filter((call) => call.method === 'POST').map((call) => JSON.parse(call.body).name);
    assert.ok(!created.includes('findWorkEmail') && !created.includes('getBalance') && !created.includes('listRuns'));
    assert.ok(created.includes('verifyEmail') && created.includes('listOperations'));

    const puts = steps.filter((step) => step.method === 'PUT').length;
    const readLines = [];
    assert.deepEqual(await readBack(steps, { baseUrl: fake.baseUrl, token: 't', names, log: (line) => readLines.push(line) }), []);
    assert.equal(readLines.length, puts);
    fake.stored.set('/api/v2/sdk/apps/my-looot/1/groups', '[]');
    assert.deepEqual(await readBack(steps, { baseUrl: fake.baseUrl, token: 't', names, log: () => {} }), ['module groups (HTTP 200)']);
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
