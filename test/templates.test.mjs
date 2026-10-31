import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATES, APP, blueprintOf } from '../templates/build.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (file) => JSON.parse(await readFile(path.join(ROOT, file), 'utf8'));
const manifest = await readJson('src/makecomapp.json');

// Module names and versions as Make's own examples write them (integromat/make-skills, read 2026-10-31).
const KNOWN = {
  'gateway:CustomWebHook': 1, 'gateway:WebhookRespond': 1, 'google-sheets:watchRows': 2, 'google-sheets:addRow': 2,
  'google-sheets:updateRow': 2, 'openai-gpt-3:CreateCompletion': 1, 'slack:CreateMessage': 4, 'hubspotcrm:createContact': 2,
  'builtin:BasicFeeder': 1, 'builtin:BasicRouter': 1, 'util:TextAggregator': 1, 'json:ParseJSON': 1,
};

const walk = (flow, out = []) => { for (const m of flow) { out.push(m); (m.routes || []).forEach((r) => walk(r.flow, out)); } return out; };

test('there are 10 to 15 templates with unique slugs', () => {
  assert.ok(TEMPLATES.length >= 10 && TEMPLATES.length <= 15);
  assert.equal(new Set(TEMPLATES.map((t) => t.slug)).size, TEMPLATES.length);
});

for (const t of TEMPLATES) {
  test(`${t.slug}: the committed blueprint matches build.mjs`, async () => {
    assert.deepEqual(await readJson(`templates/${t.slug}/blueprint.json`), blueprintOf(t));
  });

  test(`${t.slug}: modules, params and references are valid`, async () => {
    const mods = walk(t.flow);
    const ids = mods.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, 'module ids are unique');
    assert.ok(mods.some((m) => m.module.startsWith(`${APP}:`)), 'uses looot');
    assert.ok(t.description.length <= 1500, 'template description fits Make (1500)');
    assert.ok(t.scenarioDescription.length <= 240, 'scenario description fits Make (240)');
    const order = new Map();
    walk(t.flow).forEach((m, i) => order.set(m.id, i));
    for (const m of mods) {
      const text = JSON.stringify({ ...m, routes: undefined });
      assert.ok(!/__IMTCONN__|"account":\s*\d/.test(text), `${m.id} carries no connection id`);
      assert.ok(!/sk-|cs_ms_|@(?!gmail\.|yahoo\.|hotmail\.|outlook\.)[a-z0-9-]+\.[a-z]/i.test(text), `${m.id} carries no key or email`);
      if (m.module.startsWith(`${APP}:`)) {
        const name = m.module.slice(APP.length + 1);
        const component = manifest.components.module[name];
        assert.ok(component, `${name} is a module of the app`);
        const params = await readJson(path.join('src', component.codeFiles.mappableParams));
        const stat = await readJson(path.join('src', component.codeFiles.staticParams));
        const allowed = new Set(params.map((p) => p.name));
        for (const key of Object.keys(m.mapper)) assert.ok(allowed.has(key), `${name} has mappable param ${key}`);
        for (const key of Object.keys(m.parameters)) assert.ok(stat.some((p) => p.name === key), `${name} has static param ${key}`);
        for (const p of params.filter((x) => x.required)) assert.ok(m.mapper[p.name] !== undefined, `${name} gets required ${p.name}`);
        if (name === 'runOperation') {
          assert.match(m.mapper.endpointId, /^job:[a-z]+(\.[a-z]+)+$/);
          const probe = m.mapper.input.replace(/\{\{[^}]*\}\}/g, 'x');
          assert.doesNotThrow(() => JSON.parse(probe), `${m.id} input is JSON once mapped`);
          assert.ok(m.mapper.maxCostUsd > 0 && m.mapper.maxCostUsd <= 0.05, 'each run has a cost cap');
        }
      } else {
        assert.equal(KNOWN[m.module], m.version, `${m.module} v${m.version} is a known module`);
      }
      // every {{N. reference points at a module that runs earlier
      for (const [, ref] of text.matchAll(/\{\{[^}]*?\b(\d+)\.[`a-zA-Z_]/g)) {
        const id = Number(ref);
        assert.ok(order.has(id) && order.get(id) < order.get(m.id), `${m.id} maps from module ${id}, which runs before it`);
      }
    }
  });
}
