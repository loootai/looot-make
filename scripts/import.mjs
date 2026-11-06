// Creates the looot custom app in a Make account through Make's API (v2/sdk/apps), from the files
// in src/. Prints the planned requests by default; pass --apply to send them.
//
//   MAKE_API_TOKEN=<token> MAKE_ZONE=eu1.make.com node scripts/import.mjs --apply
//
// Options: --apply, --app <existing app name> (skip creating the app), --name <new app id>.
// Routes and bodies follow https://developers.make.com/api-documentation/api-reference/sdk-apps
// and the Make Apps SDK for VS Code, which deploys the same files with the same calls.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const MODULE_TYPE_IDS = { trigger: 1, action: 4, search: 9, instant_trigger: 10, responder: 11, universal: 12 };
// Local code type -> API section name, per component type.
const CONNECTION_SECTIONS = { communication: 'api', params: 'parameters' };
const RPC_SECTIONS = { communication: 'api', staticParams: 'parameters' };
const FUNCTION_SECTIONS = { code: 'code', test: 'test' };
const MODULE_SECTIONS = {
  communication: 'api',
  epoch: 'epoch',
  staticParams: 'parameters',
  mappableParams: 'expect',
  interface: 'interface',
  samples: 'samples',
};

/** Reads --flag and --flag value pairs from argv. */
export function parseArgs(argv) {
  const options = { apply: false, app: null, name: 'looot' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') options.apply = true;
    else if (argv[i] === '--app') options.app = argv[(i += 1)];
    else if (argv[i] === '--name') options.name = argv[(i += 1)];
    else throw new Error(`Unknown option: ${argv[i]}`);
  }
  return options;
}

/**
 * Builds the ordered list of API calls that create the app. A step whose path or body depends on
 * an earlier answer (the app name, the connection name Make assigns) is a function of `names`.
 */
export async function buildPlan({ srcDir = SRC, existingApp = null, newAppName = 'looot' } = {}) {
  const manifest = JSON.parse(await readFile(path.join(srcDir, 'makecomapp.json'), 'utf8'));
  const read = (file) => readFile(path.join(srcDir, file), 'utf8');
  const steps = [];
  const version = 1;

  if (!existingApp) {
    steps.push({
      label: 'create app',
      method: 'POST',
      path: () => '/sdk/apps',
      json: () => ({
        name: newAppName,
        label: 'looot',
        version,
        description: 'One key and one prepaid balance for 4,200+ data endpoints: work emails, email verification, company data.',
        theme: '#12a06a',
        language: 'en',
        audience: 'global',
      }),
      capture: (answer, names) => {
        names.app = answer.app.name;
      },
    });
  }

  for (const [localId, connection] of Object.entries(manifest.components.connection)) {
    steps.push({
      label: `create connection ${localId}`,
      method: 'POST',
      path: (names) => `/sdk/apps/${names.app}/connections`,
      json: () => ({ type: connection.connectionType, label: connection.label }),
      // An existing app keeps its connection: reuse the one with the same label.
      existing: (remote, names) => {
        const found = remote.connections.find((item) => item.label === connection.label) ?? remote.connections[0];
        if (found) names.connections[localId] = found.name;
        return Boolean(found);
      },
      capture: (answer, names) => {
        names.connections[localId] = answer.appConnection.name;
      },
    });
    for (const [codeType, section] of Object.entries(CONNECTION_SECTIONS)) {
      const text = await read(connection.codeFiles[codeType]);
      steps.push({
        label: `connection ${localId} ${section}`,
        method: 'PUT',
        path: (names) => `/sdk/apps/connections/${names.connections[localId]}/${section}`,
        text,
        contentType: 'application/jsonc',
      });
    }
  }

  steps.push({
    label: 'app base',
    method: 'PUT',
    path: (names) => `/sdk/apps/${names.app}/${version}/base`,
    text: await read(manifest.generalCodeFiles.base),
    contentType: 'application/jsonc',
  });

  for (const [name, fn] of Object.entries(manifest.components.function ?? {})) {
    steps.push({
      label: `create function ${name}`,
      method: 'POST',
      path: (names) => `/sdk/apps/${names.app}/${version}/functions`,
      json: () => ({ name }),
      existing: (remote) => remote.functions.some((item) => item.name === name),
    });
    for (const [codeType, section] of Object.entries(FUNCTION_SECTIONS)) {
      const file = fn.codeFiles[codeType];
      if (!file) continue;
      steps.push({
        label: `function ${name} ${section}`,
        method: 'PUT',
        path: (names) => `/sdk/apps/${names.app}/${version}/functions/${name}/${section}`,
        text: await read(file),
        contentType: 'application/javascript',
      });
    }
  }

  for (const [name, rpc] of Object.entries(manifest.components.rpc ?? {})) {
    steps.push({
      label: `create rpc ${name}`,
      method: 'POST',
      path: (names) => `/sdk/apps/${names.app}/${version}/rpcs`,
      json: (names) => ({ name, label: rpc.label, connection: rpc.connection ? names.connections[rpc.connection] : null }),
      existing: (remote) => remote.rpcs.some((item) => item.name === name),
    });
    for (const [codeType, section] of Object.entries(RPC_SECTIONS)) {
      steps.push({
        label: `rpc ${name} ${section}`,
        method: 'PUT',
        path: (names) => `/sdk/apps/${names.app}/${version}/rpcs/${name}/${section}`,
        text: await read(rpc.codeFiles[codeType]),
        contentType: 'application/jsonc',
      });
    }
  }

  for (const [name, module] of Object.entries(manifest.components.module)) {
    steps.push({
      label: `create module ${name}`,
      method: 'POST',
      path: (names) => `/sdk/apps/${names.app}/${version}/modules`,
      json: (names) => ({
        name,
        typeId: MODULE_TYPE_IDS[module.moduleType],
        label: module.label,
        description: module.description,
        moduleInitMode: 'blank',
        connection: module.connection ? names.connections[module.connection] : null,
        ...(module.moduleType === 'action' ? { crud: module.actionCrud ?? null } : {}),
        ...(module.moduleType === 'universal' ? { subtype: 'Universal' } : {}),
      }),
      // An existing module keeps its name and type; only its label and description change.
      existing: (remote) => remote.modules.some((item) => item.name === name),
      update: {
        method: 'PATCH',
        path: (names) => `/sdk/apps/${names.app}/${version}/modules/${name}`,
        json: () => ({ label: module.label, description: module.description }),
      },
    });
    for (const [codeType, section] of Object.entries(MODULE_SECTIONS)) {
      const file = module.codeFiles[codeType];
      if (!file) continue;
      steps.push({
        label: `module ${name} ${section}`,
        method: 'PUT',
        path: (names) => `/sdk/apps/${names.app}/${version}/modules/${name}/${section}`,
        text: await read(file),
        contentType: 'application/jsonc',
      });
    }
  }

  steps.push({
    label: 'module groups',
    method: 'PUT',
    path: (names) => `/sdk/apps/${names.app}/${version}/groups`,
    text: await read(manifest.generalCodeFiles.groups),
    contentType: 'application/json',
  });
  steps.push({
    label: 'app readme',
    method: 'PUT',
    path: (names) => `/sdk/apps/${names.app}/${version}/readme`,
    text: await read(manifest.generalCodeFiles.readme),
    contentType: 'text/markdown',
  });
  return steps;
}

/** Lists what an existing app already has, so a re-upload updates it instead of creating twice. */
async function fetchRemote(baseUrl, token, app, version = 1) {
  const get = async (path, key) => {
    const response = await fetch(`${baseUrl}${path}`, { headers: { Authorization: `Token ${token}` } });
    if (!response.ok) throw new Error(`GET ${path} answered HTTP ${response.status}`);
    return (await response.json())[key] ?? [];
  };
  return {
    connections: await get(`/sdk/apps/${app}/connections`, 'appConnections'),
    modules: await get(`/sdk/apps/${app}/${version}/modules`, 'appModules'),
    rpcs: await get(`/sdk/apps/${app}/${version}/rpcs`, 'appRpcs'),
    functions: await get(`/sdk/apps/${app}/${version}/functions`, 'appFunctions'),
  };
}

const sendStep = async (url, method, token, contentType, body) => {
  const response = await fetch(url, { method, headers: { Authorization: `Token ${token}`, 'Content-Type': contentType }, body });
  return { response, text: await response.text() };
};

/** Sends the plan in order. Stops at the first answer that is not 2xx. */
export async function runPlan(steps, { baseUrl, token, existingApp = null, apply = false, log = console.log }) {
  const names = { app: existingApp ?? '<app name Make returns>', connections: {} };
  const remote = apply && existingApp ? await fetchRemote(baseUrl, token, existingApp) : null;
  for (const step of steps) {
    if (remote && step.existing && step.existing(remote, names)) {
      if (!step.update) {
        log(`skip ${step.label} (already in the app)`);
        continue;
      }
      const url = `${baseUrl}${step.update.path(names)}`;
      const { response, text } = await sendStep(url, step.update.method, token, 'application/json', JSON.stringify(step.update.json(names)));
      if (!response.ok) throw new Error(`${step.label} failed: ${step.update.method} ${url} answered HTTP ${response.status} ${text.slice(0, 500)}`);
      log(`ok  ${step.update.method} ${url}  (${step.label}: update label and description)`);
      continue;
    }
    const url = `${baseUrl}${step.path(names)}`;
    if (!apply) {
      log(`${step.method} ${url}  (${step.label})`);
      if (step.capture && step.label.startsWith('create connection')) {
        names.connections[step.label.split(' ').pop()] = '<connection name Make returns>';
      }
      continue;
    }
    const body = step.json ? JSON.stringify(step.json(names)) : step.text;
    const { response, text: answerText } = await sendStep(url, step.method, token, step.json ? 'application/json' : step.contentType, body);
    if (!response.ok) {
      throw new Error(`${step.label} failed: ${step.method} ${url} answered HTTP ${response.status} ${answerText.slice(0, 500)}`);
    }
    if (step.capture) step.capture(JSON.parse(answerText), names);
    log(`ok  ${step.method} ${url}  (${step.label})`);
  }
  return names;
}

const stripComments = (text) => text.replace(/^\s*\/\/.*$/gm, '');
const sameJson = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
const sortKeys = (value) =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]))
      : value;

/** Reads every uploaded section back and compares it with the local file. Returns the mismatches. */
export async function readBack(steps, { baseUrl, token, names, log = console.log }) {
  const mismatches = [];
  for (const step of steps.filter((item) => item.method === 'PUT')) {
    const url = `${baseUrl}${step.path(names)}`;
    const response = await fetch(url, { headers: { Authorization: `Token ${token}` } });
    const text = await response.text();
    let same = false;
    if (response.ok) {
      if (step.contentType === 'application/jsonc' || step.contentType === 'application/json') {
        try {
          same = sameJson(JSON.parse(text), JSON.parse(stripComments(step.text)));
        } catch {
          same = false;
        }
      } else {
        same = text.trim() === step.text.trim();
      }
    }
    if (!same) mismatches.push(`${step.label} (HTTP ${response.status})`);
    log(`${same ? 'same' : 'DIFF'}  GET ${url}  (${step.label})`);
  }
  return mismatches;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const zone = process.env.MAKE_ZONE || 'eu1.make.com';
  const token = process.env.MAKE_API_TOKEN;
  if (options.apply && !token) {
    console.error('Set MAKE_API_TOKEN (Make profile, API access, with the sdk-apps:read and sdk-apps:write scopes).');
    process.exit(1);
  }
  const steps = await buildPlan({ existingApp: options.app, newAppName: options.name });
  const names = await runPlan(steps, {
    baseUrl: `https://${zone}/api/v2`,
    token,
    existingApp: options.app,
    apply: options.apply,
  });
  if (options.apply) {
    const mismatches = await readBack(steps, { baseUrl: `https://${zone}/api/v2`, token, names });
    console.log(`\nDone: ${steps.length} steps. App "${names.app}" is in your Make account under Custom apps.`);
    console.log(mismatches.length === 0 ? 'Read back: every section matches the local files.' : `Read back: ${mismatches.length} sections differ:\n${mismatches.join('\n')}`);
    if (mismatches.length > 0) process.exitCode = 1;
  } else {
    console.log(`\nDry run: ${steps.length} calls planned, none sent. Add --apply to send them.`);
  }
}
