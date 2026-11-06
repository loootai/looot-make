import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { SCHEMA_DIR } from '../scripts/fetch-schemas.mjs';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const manifest = await readJson(path.join(SRC, 'makecomapp.json'));

// Make's own schemas, from the Make Apps SDK for VS Code. The file-to-schema map is the
// `jsonValidation` table of that extension's package.json.
// unicodeRegExp is off because one pattern in Make's response schema escapes a hyphen, which the u flag rejects.
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false, unicodeRegExp: false });
for (const name of await readdir(SCHEMA_DIR)) {
  ajv.addSchema(await readJson(path.join(SCHEMA_DIR, name)), name);
}
const SCHEMA_FOR = {
  base: 'base.json',
  groups: 'groups.json',
  common: 'common.json',
  communication: 'api.json',
  params: 'parameters.json',
  staticParams: 'parameters.json',
  mappableParams: 'parameters.json',
  interface: 'parameters.json',
  samples: 'samples.json',
  epoch: 'epoch.json',
};
// Custom IML functions need Make to enable them for the account, so the app uses built-ins only.
const JS_CODE_TYPES = new Set(['code', 'test']);
const check = (schemaName, data, label) => {
  const validate = ajv.getSchema(schemaName);
  assert.ok(validate, `schema ${schemaName} is loaded`);
  assert.ok(validate(data), `${label}: ${JSON.stringify(validate.errors, null, 1)}`);
};

// Every code file with the code type that picks its schema.
const codeFiles = [];
for (const [codeType, file] of Object.entries(manifest.generalCodeFiles)) codeFiles.push({ owner: 'app', codeType, file });
for (const [type, components] of Object.entries(manifest.components)) {
  for (const [id, component] of Object.entries(components)) {
    for (const [codeType, file] of Object.entries(component.codeFiles)) codeFiles.push({ owner: `${type} ${id}`, codeType, file });
  }
}

// IML functions Make documents as built in (developers.make.com, "JavaScript in Make").
const BUILT_IN = new Set([
  'if', 'ifempty', 'switch', 'get', 'omit', 'sha256', 'createJSON', 'parseJSON', 'formatDate', 'parseDate', 'trim',
  'indexOf', 'substring', 'split', 'contains', 'keys', 'first', 'toArray', 'toCollection',
]);
const expressionsOf = (text) => [...text.matchAll(/\{\{(.*?)\}\}/g)].map((match) => match[1]);

test('makecomapp.json matches the Make Apps SDK schema', () => {
  check('makecomapp.schema.json', manifest, 'makecomapp.json');
});

test('every code file in the manifest exists and is valid JSON', async () => {
  for (const { owner, file } of codeFiles) {
    await access(path.join(SRC, file));
    if (file.endsWith('.json')) await readJson(path.join(SRC, file));
    assert.ok(!path.isAbsolute(file) && !file.includes('..'), `${owner}: ${file} is a relative path inside src`);
  }
  assert.equal(codeFiles.length, 65 - 1, 'manifest lists every file in src except itself');
});

test('every code file matches the Make schema for its type', async () => {
  let checked = 0;
  for (const { owner, codeType, file } of codeFiles) {
    if (codeType === 'readme' || JS_CODE_TYPES.has(codeType)) continue;
    check(SCHEMA_FOR[codeType], await readJson(path.join(SRC, file)), `${owner} ${codeType}`);
    checked += 1;
  }
  assert.equal(checked, 63);
});

test('module names, labels and descriptions follow the Make naming rules', () => {
  const modules = manifest.components.module;
  assert.equal(Object.keys(modules).length, 10);
  for (const [name, module] of Object.entries(modules)) {
    assert.match(name, /^[a-zA-Z][0-9a-zA-Z]+[0-9a-zA-Z]$/, `${name} matches the module name pattern`);
    assert.ok(name.length >= 3 && name.length <= 48);
    assert.match(module.label, /^[A-Z][^A-Z]*(API|ID)?[^A-Z]*$/, `${name} label is sentence case: ${module.label}`);
    assert.match(module.description, /^[A-Z].*\.$/, `${name} description is a sentence`);
    assert.equal(module.connection, 'looot');
  }
  assert.equal(modules.makeApiCall.label, 'Make an API call');
  assert.equal(modules.makeApiCall.description, 'Performs an arbitrary authorized API call.');
  assert.equal(Object.values(modules).filter((module) => module.moduleType === 'universal').length, 1);
});

test('module groups list every module exactly once', async () => {
  const groups = await readJson(path.join(SRC, manifest.generalCodeFiles.groups));
  const grouped = groups.flatMap((group) => group.modules).sort();
  assert.deepEqual(grouped, Object.keys(manifest.components.module).sort());
});

test('base sends the bearer token to api.looot.ai and hides it in logs', async () => {
  const base = await readJson(path.join(SRC, manifest.generalCodeFiles.base));
  assert.equal(base.baseUrl, 'https://api.looot.ai');
  assert.equal(base.headers.Authorization, 'Bearer {{connection.apiKey}}');
  assert.deepEqual(base.log.sanitize, ['request.headers.authorization']);
  assert.ok(base.response.error['402'].message.includes('Nothing was charged'));
});

test('the connection tests the token against GET /v1/balance', async () => {
  const files = manifest.components.connection.looot.codeFiles;
  const communication = await readJson(path.join(SRC, files.communication));
  const params = await readJson(path.join(SRC, files.params));
  assert.equal(communication.url, 'https://api.looot.ai/v1/balance');
  assert.equal(communication.method, 'GET');
  assert.equal(communication.headers.Authorization, 'Bearer {{parameters.apiKey}}');
  assert.deepEqual(communication.log.sanitize, ['request.headers.authorization']);
  assert.equal(params[0].name, 'apiKey');
  assert.equal(params[0].type, 'password');
});

test('modules call relative paths; only the universal module names the host', async () => {
  for (const [name, module] of Object.entries(manifest.components.module)) {
    const communication = await readJson(path.join(SRC, module.codeFiles.communication));
    if (name === 'makeApiCall') {
      assert.equal(communication.url, 'https://api.looot.ai/{{parameters.url}}', 'the user can only change the path');
    } else {
      assert.match(communication.url, /^\/v1\//, `${name} uses a path relative to the base URL`);
    }
  }
});

test('run modules send the documented POST /v1/runs body', async () => {
  const jobs = { findWorkEmail: 'job:people.email.find', verifyEmail: 'job:people.email.verify', enrichCompany: 'job:company.enrich' };
  for (const name of ['findWorkEmail', 'verifyEmail', 'enrichCompany', 'runOperation']) {
    const module = manifest.components.module[name];
    const communication = await readJson(path.join(SRC, module.codeFiles.communication));
    assert.equal(communication.url, '/v1/runs');
    assert.equal(communication.method, 'POST');
    assert.deepEqual(Object.keys(communication.body).sort(), ['endpointId', 'fallback', 'idempotencyKey', 'input', 'wait']);
    if (jobs[name]) assert.equal(communication.body.endpointId, jobs[name]);
    assert.ok(communication.body.idempotencyKey.startsWith('{{ifempty(parameters.idempotencyKey, '));
    assert.ok(communication.response.valid.condition.includes("body.status != 'failed'"));
  }
  // The Leads modules name their inputs after the job's own fields and pass them through in bulk.
  const inputs = { findWorkEmail: ['first_name', 'last_name', 'domain', 'linkedin_url'], verifyEmail: ['email'], enrichCompany: ['domain', 'name', 'linkedin_url'] };
  for (const [name, fields] of Object.entries(inputs)) {
    const files = manifest.components.module[name].codeFiles;
    const communication = await readJson(path.join(SRC, files.communication));
    assert.equal(communication.body.input, "{{omit(parameters, 'fallback', 'maxCostUsd', 'wait', 'idempotencyKey')}}");
    const params = (await readJson(path.join(SRC, files.mappableParams))).map((parameter) => parameter.name);
    assert.deepEqual(params.slice(0, fields.length), fields, `${name} inputs use the API field names`);
  }
});

const namesIn = (parameters, out = new Set()) => {
  if (!Array.isArray(parameters)) return out;
  for (const parameter of parameters) {
    if (typeof parameter !== 'object') continue;
    out.add(parameter.name);
    const options = Array.isArray(parameter.options) ? parameter.options : [];
    for (const option of options) namesIn(option.nested, out);
  }
  return out;
};

test('action outputs return the API response as is, then the convenience fields', async () => {
  for (const name of ['findWorkEmail', 'verifyEmail', 'enrichCompany', 'runOperation', 'getRun', 'getOperation', 'getBalance']) {
    const communication = await readJson(path.join(SRC, manifest.components.module[name].codeFiles.communication));
    const output = communication.response.output;
    if (typeof output === 'string') assert.equal(output, '{{body}}');
    else assert.equal(Object.keys(output)[0], '{{...}}', `${name} spreads the body first`), assert.equal(output['{{...}}'], '{{body}}');
  }
});

test('run dates are parsed with parseDate', async () => {
  for (const name of ['findWorkEmail', 'verifyEmail', 'enrichCompany', 'runOperation', 'getRun']) {
    const { output } = (await readJson(path.join(SRC, manifest.components.module[name].codeFiles.communication))).response;
    for (const field of ['createdAt', 'completedAt']) assert.match(output[field], new RegExp(`parseDate\\(body\\.${field}\\)`), `${name} ${field}`);
  }
  const watch = (await readJson(path.join(SRC, manifest.components.module.watchFinishedRuns.codeFiles.communication))).response;
  assert.equal(watch.trigger.date, '{{parseDate(item.createdAt)}}');
  assert.match(watch.output.createdAt, /parseDate\(item\.createdAt\)/);
  assert.match(watch.output.completedAt, /parseDate\(item\.completedAt\)/);
});

test('Search operations pages with a fixed page size and stops on nextOffset null', async () => {
  const files = manifest.components.module.searchCatalog.codeFiles;
  const communication = await readJson(path.join(SRC, files.communication));
  assert.equal(communication.qs.limit, 100, 'fixed page size, at most the API maximum of 200');
  assert.equal(communication.pagination.qs.offset, '{{(pagination.page - 1) * 100}}');
  assert.equal(communication.pagination.condition, '{{body.nextOffset != null}}');
  assert.equal(communication.response.iterate, '{{body.endpoints}}');
  assert.equal(communication.response.limit, '{{ifempty(parameters.limit, 10)}}');
  assert.match(communication.qs.maxPriceMicros, /parameters\.maxPriceUsd \* 1000000/);
  const params = await readJson(path.join(SRC, files.mappableParams));
  assert.equal(params.find((parameter) => parameter.name === 'limit').help, 'Maximum number of results to return and work with during one execution cycle.');
  assert.ok(!params.some((parameter) => parameter.name === 'maxPriceMicros'));
});

test('Watch finished runs pages newest first and declares that order', async () => {
  const files = manifest.components.module.watchFinishedRuns.codeFiles;
  for (const file of [files.communication, files.epoch]) {
    const communication = await readJson(path.join(SRC, file));
    assert.equal(communication.qs.limit, 50, 'GET /v1/runs takes at most 50 per page');
    assert.deepEqual(communication.pagination, { qs: { cursor: '{{body.nextCursor}}' }, condition: '{{body.nextCursor != null}}' });
  }
  const communication = await readJson(path.join(SRC, files.communication));
  assert.equal(communication.response.trigger.order, 'desc');
  const limit = (await readJson(path.join(SRC, files.staticParams)))[0];
  assert.equal(limit.help, 'Maximum number of results to return.');
});

test('every rpc:// reference names an RPC of the app, and selectors stay editable', async () => {
  const rpcs = new Set(Object.keys(manifest.components.rpc));
  for (const { owner, file } of codeFiles) {
    if (!file.endsWith('.json')) continue;
    const text = await readFile(path.join(SRC, file), 'utf8');
    for (const [, name] of text.matchAll(/rpc:\/\/([A-Za-z]+)/g)) assert.ok(rpcs.has(name), `${owner}: rpc://${name} exists`);
  }
  for (const [module, field, rpc] of [['runOperation', 'endpointId', 'listOperations'], ['getOperation', 'endpointId', 'listOperations'], ['getRun', 'runId', 'listRuns']]) {
    const params = await readJson(path.join(SRC, manifest.components.module[module].codeFiles.mappableParams));
    const select = params.find((parameter) => parameter.name === field);
    assert.equal(select.type, 'select');
    assert.equal(select.mode, 'edit', `${module} ${field} also takes a typed or mapped ID`);
    assert.equal(select.options, `rpc://${rpc}`);
  }
  for (const name of rpcs) {
    const communication = await readJson(path.join(SRC, manifest.components.rpc[name].codeFiles.communication));
    if (communication.response.iterate) assert.ok(Number.isInteger(communication.response.limit) && communication.response.limit <= 500, `${name} has a fixed bounded limit`);
  }
});

test('the app defines no custom IML functions', () => {
  assert.deepEqual(manifest.components.function, {});
});

test('the input fields RPC reads an endpoint schema, or the job inputs for a job: id', async () => {
  const communication = await readJson(path.join(SRC, manifest.components.rpc.operationInputFields.codeFiles.communication));
  assert.match(communication.url, /'\/v1\/catalog\/search', '\/v1\/operations\/' \+ trim\(parameters\.endpointId\)/);
  assert.match(communication.response.iterate, /keys\(get\(first\(toArray\(body\.jobInputs\)\), 'value'\)\), keys\(body\.inputSchema\.properties\)/);
  assert.deepEqual(Object.keys(communication.response.output), ['name', 'label', 'type', 'required', 'help']);
  assert.match(communication.response.output.type, /'string', 'text'/);
});

test('Run an operation sends an object: parsed JSON text or the dynamic fields', async () => {
  const files = manifest.components.module.runOperation.codeFiles;
  const communication = await readJson(path.join(SRC, files.communication));
  assert.match(communication.body.input, /parseJSON\(ifempty\(parameters\.input, '\{\}'\)\)/);
  assert.match(communication.body.input, /parameters\.inputMode == 'fields', omit\(parameters,/);
  const mode = (await readJson(path.join(SRC, files.mappableParams))).find((parameter) => parameter.name === 'inputMode');
  assert.deepEqual(mode.options.map((option) => option.value), ['json', 'fields']);
  assert.equal(mode.options[1].nested, 'rpc://operationInputFields');
});

test('groups: Watch finished runs first in Runs, the balance in Workspace, only the API call in Other', async () => {
  const groups = await readJson(path.join(SRC, manifest.generalCodeFiles.groups));
  assert.deepEqual(groups.map((group) => group.label), ['Leads', 'Catalog', 'Runs', 'Workspace', 'Other']);
  assert.equal(groups[2].modules[0], 'watchFinishedRuns');
  assert.deepEqual(groups[3].modules, ['getBalance']);
  assert.deepEqual(groups[4].modules, ['makeApiCall']);
});

test('only Run an operation says fallback works with job IDs only', async () => {
  for (const [name, module] of Object.entries(manifest.components.module)) {
    const text = await readFile(path.join(SRC, module.codeFiles.mappableParams), 'utf8');
    assert.equal(text.includes('Works with job IDs only'), name === 'runOperation', name);
  }
});

test('error messages fall back when the API sends no error body', async () => {
  const base = await readJson(path.join(SRC, manifest.generalCodeFiles.base));
  assert.match(base.response.error.message, /ifempty\(body\.error\.code,/);
  assert.match(base.response.error.message, /ifempty\(body\.error\.message,/);
});

test('every parameter a module reads is defined in its parameter files', async () => {
  for (const [name, module] of Object.entries(manifest.components.module)) {
    const text = await readFile(path.join(SRC, module.codeFiles.communication), 'utf8');
    const defined = new Set();
    for (const codeType of ['staticParams', 'mappableParams']) namesIn(await readJson(path.join(SRC, module.codeFiles[codeType])), defined);
    const used = new Set([...text.matchAll(/parameters\.([A-Za-z_]+)/g)].map((match) => match[1]));
    for (const parameter of used) assert.ok(defined.has(parameter), `${name} reads parameters.${parameter}, which is not defined`);
  }
});

test('IML expressions are balanced and call only built-in functions', async () => {
  for (const { owner, file } of codeFiles) {
    if (!file.endsWith('.iml.json')) continue;
    const text = await readFile(path.join(SRC, file), 'utf8');
    assert.equal((text.match(/\{\{/g) || []).length, (text.match(/\}\}/g) || []).length, `${owner}: braces balance in ${file}`);
    for (const expression of expressionsOf(JSON.stringify(JSON.parse(text)))) {
      for (const call of expression.matchAll(/([A-Za-z]+)\(/g)) {
        assert.ok(BUILT_IN.has(call[1]), `${owner}: ${call[1]}() in ${file} is not a built-in IML function`);
      }
      const opens = (expression.match(/\(/g) || []).length;
      assert.equal(opens, (expression.match(/\)/g) || []).length, `${owner}: parentheses balance in ${expression}`);
    }
  }
});

test('the trigger lists runs and keeps the ones in a final status', async () => {
  const module = manifest.components.module.watchFinishedRuns;
  const communication = await readJson(path.join(SRC, module.codeFiles.communication));
  assert.equal(communication.url, '/v1/runs');
  assert.equal(communication.response.iterate.container, '{{body.runs}}');
  for (const status of ['completed', 'failed', 'blocked', 'stopped']) {
    assert.ok(communication.response.iterate.condition.includes(`'${status}'`));
  }
  assert.equal(communication.response.trigger.id, '{{item.runId}}');
  assert.equal(communication.response.trigger.type, 'date');
  assert.ok(module.codeFiles.epoch);
});
