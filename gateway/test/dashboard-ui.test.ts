import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const html = fs.readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8');
function definition(name: string, next: string): string {
  const start = html.indexOf(`function ${name}(`);
  const end = html.indexOf(`function ${next}(`, start);
  assert.ok(start >= 0 && end > start);
  return html.slice(start, end);
}

function fixture() {
  const dom = new JSDOM('<body><input id="customModelAlias"><div id="customModelProvider"><div class="psel-wrap"><select><option value="openrouter">OpenRouter</option></select></div></div><div id="customModelResolved"></div><div id="existingModel"></div></body>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window as any;
  const updates: unknown[][] = [];
  w.PROVIDER_META = { openrouter: { label: 'OpenRouter' } };
  w.logoHtml = () => '';
  w.esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  w._fetchedModels = {};
  w._toggledModels = {};
  w._modelConfig = { _provider_models: {} };
  w.setModelName = (...args: unknown[]) => updates.push(args);
  w.renderCustomModelMappings = w.renderModelCards = w.toast = () => {};
  w.eval(definition('attachModelField', 'createModelNameFieldHtml'));
  w.eval(definition('addCustomModelMapping', 'removeCustomModelMapping'));
  return { dom, w, updates };
}

test('custom mapping accepts an arbitrary model without discovery and adds only the requested alias', () => {
  const { dom, w, updates } = fixture();
  try {
    w.attachModelField('customModelResolved', 'custom_openrouter', 'openrouter', '');
    const search = w.document.querySelector('.rsel-menu input');
    search.value = 'fixture-model';
    search.dispatchEvent(new w.Event('input'));
    const manual = w.document.querySelector('.rsel-manual');
    assert.equal(manual.hidden, false);
    assert.equal(manual.textContent, 'Use model name: fixture-model');
    search.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    assert.equal(w.document.querySelector('#customModelResolved .rsel-value').value, 'fixture-model');
    assert.equal(updates.length, 0, 'draft selection must not add a phantom custom_<provider> mapping');
    w.document.getElementById('customModelAlias').value = 'browser-demo';
    w.addCustomModelMapping();
    assert.equal(JSON.stringify(w._modelConfig._provider_models), JSON.stringify({ 'browser-demo': { openrouter: 'fixture-model' } }));
  } finally { dom.window.close(); }
});

test('model picker uses fetched rows when the selected-model list is empty and supports explicit manual selection', () => {
  const { dom, w, updates } = fixture();
  try {
    w._fetchedModels.openrouter = ['discovered-model'];
    w._toggledModels.openrouter = [];
    w.attachModelField('existingModel', 'demo', 'openrouter', '');
    w.document.querySelector('.rsel-item').click();
    assert.deepEqual(updates[0], ['demo', 'openrouter', 'discovered-model']);
    const search = w.document.querySelector('.rsel-menu input');
    const name = 'manual/<model>"quoted';
    search.value = name;
    search.dispatchEvent(new w.Event('input'));
    w.document.querySelector('.rsel-manual').click();
    assert.deepEqual(updates[1], ['demo', 'openrouter', name]);
    assert.equal(w.document.querySelector('.rsel-text').textContent, name);
    assert.equal(w.document.querySelector('.rsel-text model'), null);
  } finally { dom.window.close(); }
});

test('login redirect stays on the dashboard origin and tolerates malformed next URLs', () => {
  const login = fs.readFileSync(new URL('../dashboard/login.html', import.meta.url), 'utf8');
  const start = login.indexOf('const params =');
  const end = login.indexOf('const stored =', start);
  for (const [next, expected] of [['javascript:alert(1)', '/'], ['//outside.invalid/', '/'], ['http://[', '/'], ['/models?view=custom', '/models?view=custom']]) {
    const dom = new JSDOM('', { url: 'http://localhost/login.html?next=' + encodeURIComponent(next), runScripts: 'outside-only' });
    try {
      dom.window.eval(login.slice(start, end) + '\nwindow.redirectResult = nextUrl;');
      assert.equal((dom.window as any).redirectResult, expected);
    } finally { dom.window.close(); }
  }
});

test('history Replay handles colon IDs and sends only the stored request ID and selected alias', async () => {
  const id = 'fixture-uuid:out';
  const dom = new JSDOM(`<body><button id="replay-${id}">Replay</button><select id="rmodel-${id}"><option value="demo">demo</option></select><span id="rr-${id}" style="display:none"></span></body>`, { url: 'http://localhost/', runScripts: 'outside-only' });
  const w = dom.window as any;
  const calls: any[] = [];
  w.api = async (...args: any[]) => { calls.push(args); return { ok: true, text: 'Replayed the complete stored request' }; };
  w.toast = () => {};
  w.eval('async ' + definition('replayRequest', 'renderFailoverTimeline'));
  try {
    await w.replayRequest(id);
    assert.equal(JSON.stringify(calls), JSON.stringify([['POST', '/api/replay', { requestId: id, model: 'demo' }]]));
    assert.equal(w.document.getElementById('rr-' + id).textContent, 'Replayed the complete stored request');
    assert.equal(w.document.getElementById('replay-' + id).disabled, false);
  } finally { dom.window.close(); }
});
