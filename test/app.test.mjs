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
const BUILT_IN = new Set(['if', 'ifempty', 'sha256', 'createJSON', 'parseJSON', 'formatDate', 'trim', 'toCollection']);
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
  assert.equal(codeFiles.length, 59 - 1, 'manifest lists every file in src except itself');
});

test('every code file matches the Make schema for its type', async () => {
  let checked = 0;
  for (const { owner, codeType, file } of codeFiles) {
    if (codeType === 'readme') continue;
    check(SCHEMA_FOR[codeType], await readJson(path.join(SRC, file)), `${owner} ${codeType}`);
    checked += 1;
  }
  assert.equal(checked, 57);
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
  const find = await readJson(path.join(SRC, manifest.components.module.findWorkEmail.codeFiles.communication));
  assert.deepEqual(Object.keys(find.body.input), ['first_name', 'last_name', 'name', 'domain', 'company', 'linkedin_url']);
});

test('every parameter a module reads is defined in its parameter files', async () => {
  for (const [name, module] of Object.entries(manifest.components.module)) {
    const text = await readFile(path.join(SRC, module.codeFiles.communication), 'utf8');
    const defined = new Set();
    for (const codeType of ['staticParams', 'mappableParams']) {
      for (const parameter of await readJson(path.join(SRC, module.codeFiles[codeType]))) defined.add(parameter.name);
    }
    const used = new Set([...text.matchAll(/parameters\.([A-Za-z]+)/g)].map((match) => match[1]));
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
