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

/** Sends the plan in order. Stops at the first answer that is not 2xx. */
export async function runPlan(steps, { baseUrl, token, existingApp = null, apply = false, log = console.log }) {
  const names = { app: existingApp ?? '<app name Make returns>', connections: {} };
  for (const step of steps) {
    const url = `${baseUrl}${step.path(names)}`;
    if (!apply) {
      log(`${step.method} ${url}  (${step.label})`);
      if (step.capture && step.label.startsWith('create connection')) {
        names.connections[step.label.split(' ').pop()] = '<connection name Make returns>';
      }
      continue;
    }
    const body = step.json ? JSON.stringify(step.json(names)) : step.text;
    const response = await fetch(url, {
      method: step.method,
      headers: { Authorization: `Token ${token}`, 'Content-Type': step.json ? 'application/json' : step.contentType },
      body,
    });
    const answerText = await response.text();
    if (!response.ok) {
      throw new Error(`${step.label} failed: ${step.method} ${url} answered HTTP ${response.status} ${answerText.slice(0, 500)}`);
    }
    if (step.capture) step.capture(JSON.parse(answerText), names);
    log(`ok  ${step.method} ${url}  (${step.label})`);
  }
  return names;
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
    console.log(`\nDone: ${steps.length} calls. App "${names.app}" is in your Make account under Custom apps.`);
  } else {
    console.log(`\nDry run: ${steps.length} calls planned, none sent. Add --apply to send them.`);
  }
}
