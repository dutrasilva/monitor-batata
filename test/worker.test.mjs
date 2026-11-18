import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { runCheck, normalizePhone, StateStore, notifyAll } from '../src/worker.js';

const MIN = 60_000;
const NOW = Date.parse('2026-11-18T19:30:00Z'); // 16:30 em São Paulo

const feed = (ts, { t = '24.5', h = '70' } = {}) => ({
  created_at: new Date(ts).toISOString(),
  entry_id: ts,
  field1: t,
  field2: h,
});

/** ThingSpeak e provedor de SMS simulados. */
function makeWorld({ channels = {}, smsFail = () => false } = {}) {
  const sms = [];
  const fetchFn = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('thingspeak')) {
      const id = u.match(/channels\/(\d+)\//)[1];
      const data = channels[id];
      if (data instanceof Error) throw data;
      if (typeof data === 'number') return new Response('{}', { status: data });
      return Response.json({ channel: { id }, feeds: data });
    }
    let to, body, provider;
    if (u.includes('twilio')) {
      const form = new URLSearchParams(init.body);
      provider = 'twilio';
      to = form.get('To');
      body = form.get('Body');
    } else {
      const j = JSON.parse(init.body);
      provider = 'zenvia';
      to = j.to;
      body = j.contents[0].text;
    }
    if (smsFail(to)) return new Response('{"message":"falhou"}', { status: 400 });
    sms.push({ provider, to, body, url: u, init });
    return new Response('{}', { status: 201 });
  };
  return { sms, fetchFn };
}

function makeStore(initial = {}) {
  let data = structuredClone(initial);
  return {
    saves: 0,
    async load() {
      return structuredClone(data);
    },
    async save(obj) {
      this.saves++;
      data = structuredClone(obj);
    },
    get data() {
      return data;
    },
  };
}

const baseEnv = {
  CHANNEL_1: '111',
  CHANNEL_2: '222',
  ALERT_PHONES: '+5542999990001, 42999990002',
  TWILIO_ACCOUNT_SID: 'ACtest',
  TWILIO_AUTH_TOKEN: 'secret',
  TWILIO_FROM: '+15550001111',
};

const fresh = (ts = NOW) => [feed(ts - 20_000), feed(ts - 5_000)];

test('dois monitores atualizados: nenhum SMS e nada gravado', async () => {
  const { sms, fetchFn } = makeWorld({ channels: { 111: fresh(), 222: fresh() } });
  const store = makeStore();
  await runCheck(baseEnv, { store, now: NOW, fetchFn });
  assert.equal(sms.length, 0);
  assert.equal(store.saves, 0);
});

test('limite: exatamente 5 min não alerta; 5 min + 1 s alerta', async () => {
  let w = makeWorld({ channels: { 111: [feed(NOW - 5 * MIN)], 222: fresh() } });
  let store = makeStore();
  await runCheck(baseEnv, { store, now: NOW, fetchFn: w.fetchFn });
  assert.equal(w.sms.length, 0, 'exatamente 5 min');

  w = makeWorld({ channels: { 111: [feed(NOW - 5 * MIN - 1000)], 222: fresh() } });
  store = makeStore();
  await runCheck(baseEnv, { store, now: NOW, fetchFn: w.fetchFn });
  assert.equal(w.sms.length, 2, 'um SMS por contato');
});

test('Monitor 1 parado: SMS para os dois contatos, texto cita só o Monitor 1', async () => {
  const { sms, fetchFn } = makeWorld({ channels: { 111: [feed(NOW - 7 * MIN)], 222: fresh() } });
  const store = makeStore();
  await runCheck(baseEnv, { store, now: NOW, fetchFn });

  assert.deepEqual(sms.map((s) => s.to).sort(), ['+5542999990001', '+5542999990002']);
  const body = sms[0].body;
  assert.match(body, /^ALERTA Estufa Batata: Monitor 1 INOPERANTE - sem atualizacao ha 7 min \(ultimo: 18\/11 16:23\)\.$/);
  assert.doesNotMatch(body, /Monitor 2/);
  assert.match(body, /^[\x20-\x7e]+$/, 'somente ASCII');
  assert.equal(store.data['1'].alerted, true);
  assert.equal(store.data['2'], undefined);

  // credenciais do Twilio vão no cabeçalho Basic
  assert.equal(sms[0].init.headers.Authorization, `Basic ${btoa('ACtest:secret')}`);
  assert.match(sms[0].url, /Accounts\/ACtest\/Messages\.json$/);
});

test('Monitor 2 parado: texto cita só o Monitor 2', async () => {
  const { sms, fetchFn } = makeWorld({ channels: { 111: fresh(), 222: [feed(NOW - 9 * MIN)] } });
  await runCheck(baseEnv, { store: makeStore(), now: NOW, fetchFn });
  assert.equal(sms.length, 2);
  assert.match(sms[0].body, /Monitor 2 INOPERANTE/);
  assert.doesNotMatch(sms[0].body, /Monitor 1/);
});

test('os dois parados ao mesmo tempo: uma única mensagem por contato citando ambos', async () => {
  const { sms, fetchFn } = makeWorld({ channels: { 111: [feed(NOW - 8 * MIN)], 222: [feed(NOW - 10 * MIN)] } });
  await runCheck(baseEnv, { store: makeStore(), now: NOW, fetchFn });
  assert.equal(sms.length, 2);
  assert.match(sms[0].body, /Monitor 1 INOPERANTE.*Monitor 2 INOPERANTE/);
});

test('continua parado: não repete o SMS a cada minuto', async () => {
  const { sms, fetchFn } = makeWorld({ channels: { 111: [feed(NOW - 7 * MIN)], 222: fresh() } });
  const store = makeStore();
  await runCheck(baseEnv, { store, now: NOW, fetchFn });
  await runCheck(baseEnv, { store, now: NOW + MIN, fetchFn });
  await runCheck(baseEnv, { store, now: NOW + 2 * MIN, fetchFn });
  assert.equal(sms.length, 2);
});

test('lembrete opcional: só após REMINDER_MINUTES, com prefixo LEMBRETE', async () => {
  const env = { ...baseEnv, REMINDER_MINUTES: '60' };
  const last = NOW - 7 * MIN;
  const { sms, fetchFn } = makeWorld({ channels: { 111: [feed(last)], 222: (() => fresh())() } });
  const store = makeStore();
  await runCheck(env, { store, now: NOW, fetchFn });
  assert.equal(sms.length, 2);

  // 30 min depois: ainda não. (canal 2 precisa continuar atualizado)
  const w2 = makeWorld({ channels: { 111: [feed(last)], 222: fresh(NOW + 30 * MIN) } });
  await runCheck(env, { store, now: NOW + 30 * MIN, fetchFn: w2.fetchFn });
  assert.equal(w2.sms.length, 0);

  const w3 = makeWorld({ channels: { 111: [feed(last)], 222: fresh(NOW + 61 * MIN) } });
  await runCheck(env, { store, now: NOW + 61 * MIN, fetchFn: w3.fetchFn });
  assert.equal(w3.sms.length, 2);
  assert.match(w3.sms[0].body, /^LEMBRETE Estufa Batata: Monitor 1 INOPERANTE/);
});

test('recuperação: avisa quando volta e limpa o estado', async () => {
  const stale = makeWorld({ channels: { 111: [feed(NOW - 7 * MIN)], 222: fresh() } });
  const store = makeStore();
  await runCheck(baseEnv, { store, now: NOW, fetchFn: stale.fetchFn });

  const later = NOW + 4 * MIN;
  const ok = makeWorld({ channels: { 111: fresh(later), 222: fresh(later) } });
  await runCheck(baseEnv, { store, now: later, fetchFn: ok.fetchFn });

  assert.equal(ok.sms.length, 2);
  assert.match(ok.sms[0].body, /^OK Estufa Batata: Monitor 1 voltou a atualizar \(inoperante por 11 min\)\.$/);
  assert.deepEqual(store.data, {});
});

test('SEND_RECOVERY=false: não manda aviso de recuperação', async () => {
  const env = { ...baseEnv, SEND_RECOVERY: 'false' };
  const store = makeStore();
  await runCheck(env, { store, now: NOW, fetchFn: makeWorld({ channels: { 111: [feed(NOW - 7 * MIN)], 222: fresh() } }).fetchFn });
  const later = NOW + 3 * MIN;
  const ok = makeWorld({ channels: { 111: fresh(later), 222: fresh(later) } });
  await runCheck(env, { store, now: later, fetchFn: ok.fetchFn });
  assert.equal(ok.sms.length, 0);
  assert.deepEqual(store.data, {});
});

test('falha total no envio: tenta de novo no minuto seguinte e depois não duplica', async () => {
  const channels = { 111: [feed(NOW - 7 * MIN)], 222: fresh() };
  const store = makeStore();

  const broken = makeWorld({ channels, smsFail: () => true });
  await runCheck(baseEnv, { store, now: NOW, fetchFn: broken.fetchFn });
  assert.equal(broken.sms.length, 0);
  assert.equal(store.data['1'].alerted, false);

  const working = makeWorld({ channels: { 111: [feed(NOW - 7 * MIN)], 222: fresh(NOW + MIN) } });
  await runCheck(baseEnv, { store, now: NOW + MIN, fetchFn: working.fetchFn });
  assert.equal(working.sms.length, 2);
  assert.equal(store.data['1'].alerted, true);

  const again = makeWorld({ channels: { 111: [feed(NOW - 7 * MIN)], 222: fresh(NOW + 2 * MIN) } });
  await runCheck(baseEnv, { store, now: NOW + 2 * MIN, fetchFn: again.fetchFn });
  assert.equal(again.sms.length, 0);
});

test('falha parcial (um contato inválido): considera alertado e não reenvia aos demais', async () => {
  const { sms, fetchFn } = makeWorld({
    channels: { 111: [feed(NOW - 7 * MIN)], 222: fresh() },
    smsFail: (to) => to === '+5542999990002',
  });
  const store = makeStore();
  await runCheck(baseEnv, { store, now: NOW, fetchFn });
  assert.equal(sms.length, 1);
  assert.equal(store.data['1'].alerted, true);
});

test('erro ao consultar o ThingSpeak: não alerta e preserva o estado salvo', async () => {
  const saved = { 1: { down: true, since: NOW - 10 * MIN, lastDataAt: NOW - 15 * MIN, alerted: true, notifiedAt: NOW - 9 * MIN } };
  const store = makeStore(saved);
  const { sms, fetchFn } = makeWorld({ channels: { 111: new Error('rede'), 222: 500 } });
  await runCheck(baseEnv, { store, now: NOW, fetchFn });
  assert.equal(sms.length, 0);
  assert.equal(store.saves, 0);
  assert.deepEqual(store.data, saved);
});

test('leituras inválidas (campos vazios, umidade > 100) contam como sem atualização', async () => {
  const bad = [
    { ...feed(NOW - 10_000), field1: null },
    { ...feed(NOW - 5_000), field2: '150' },
    { ...feed(NOW - 2_000), field1: '', field2: '' },
  ];
  const { sms, fetchFn } = makeWorld({ channels: { 111: [...bad, feed(NOW - 8 * MIN)], 222: fresh() } });
  await runCheck(baseEnv, { store: makeStore(), now: NOW, fetchFn });
  assert.equal(sms.length, 2);
  assert.match(sms[0].body, /ha 8 min/);
});

test('canal sem nenhuma leitura válida: alerta com texto próprio', async () => {
  const { sms, fetchFn } = makeWorld({ channels: { 111: [], 222: fresh() } });
  await runCheck(baseEnv, { store: makeStore(), now: NOW, fetchFn });
  assert.match(sms[0].body, /Monitor 1 INOPERANTE - sem leitura valida recente/);
});

test('sem contatos ou sem credenciais: não quebra e fica pendente para quando configurar', async () => {
  const channels = { 111: [feed(NOW - 7 * MIN)], 222: fresh() };
  for (const env of [{ ...baseEnv, ALERT_PHONES: '' }, { ...baseEnv, TWILIO_AUTH_TOKEN: '' }, { ...baseEnv, SMS_PROVIDER: 'xyz' }]) {
    const { sms, fetchFn } = makeWorld({ channels });
    const store = makeStore();
    await runCheck(env, { store, now: NOW, fetchFn });
    assert.equal(sms.length, 0);
    assert.equal(store.data['1'].alerted, false);
  }
});

test('CHANNEL_2 vazio: só o Monitor 1 é verificado', async () => {
  const { sms, fetchFn } = makeWorld({ channels: { 111: fresh() } });
  await runCheck({ ...baseEnv, CHANNEL_2: '' }, { store: makeStore(), now: NOW, fetchFn });
  assert.equal(sms.length, 0);
});

test('canal privado: envia a Read API Key', async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(String(url));
    return Response.json({ feeds: fresh() });
  };
  await runCheck({ ...baseEnv, READ_KEY_1: 'abc123' }, { store: makeStore(), now: NOW, fetchFn });
  assert.ok(urls.some((u) => u.includes('/channels/111/') && u.includes('api_key=abc123')));
  assert.ok(urls.some((u) => u.includes('/channels/222/') && !u.includes('api_key')));
});

test('Zenvia: corpo no formato da API v2 e número sem "+"', async () => {
  const env = { ...baseEnv, SMS_PROVIDER: 'zenvia', ZENVIA_API_TOKEN: 'tok', ZENVIA_FROM: 'estufa', ALERT_PHONES: '+5542999990001' };
  const { sms, fetchFn } = makeWorld({ channels: { 111: [feed(NOW - 7 * MIN)], 222: fresh() } });
  await runCheck(env, { store: makeStore(), now: NOW, fetchFn });
  assert.equal(sms.length, 1);
  assert.equal(sms[0].provider, 'zenvia');
  assert.equal(sms[0].to, '5542999990001');
  assert.equal(sms[0].url, 'https://api.zenvia.com/v2/channels/sms/messages');
  assert.equal(sms[0].init.headers['X-API-TOKEN'], 'tok');
  assert.equal(JSON.parse(sms[0].init.body).from, 'estufa');
});

test('Twilio com Messaging Service usa MessagingServiceSid no lugar de From', async () => {
  let form;
  const fetchFn = async (_url, init) => {
    form = new URLSearchParams(init.body);
    return new Response('{}', { status: 201 });
  };
  const env = { ...baseEnv, TWILIO_FROM: '', TWILIO_MESSAGING_SERVICE_SID: 'MG123', ALERT_PHONES: '+5542999990001' };
  const res = await notifyAll(env, 'oi', fetchFn);
  assert.equal(res.sent, 1);
  assert.equal(form.get('MessagingServiceSid'), 'MG123');
  assert.equal(form.get('From'), null);
});

test('normalizePhone', () => {
  assert.equal(normalizePhone('+55 (42) 99999-0001'), '+5542999990001');
  assert.equal(normalizePhone('42999990001'), '+5542999990001');
  assert.equal(normalizePhone('5542999990001'), '+5542999990001');
  assert.equal(normalizePhone('4232220001'), '+554232220001');
  assert.equal(normalizePhone('+15551234567'), '+15551234567');
  assert.equal(normalizePhone(''), null);
});

test('endpoint /api/test-sms: desligado sem ADMIN_TOKEN, exige Bearer e envia', async () => {
  const assets = { fetch: async () => new Response('<html>dash</html>') };
  const req = (headers = {}, method = 'POST') => new Request('https://x.workers.dev/api/test-sms', { method, headers });

  assert.equal((await worker.fetch(req(), { ...baseEnv, ASSETS: assets })).status, 404);

  const env = { ...baseEnv, ADMIN_TOKEN: 's3nha', ASSETS: assets };
  assert.equal((await worker.fetch(req({}, 'GET'), env)).status, 405);
  assert.equal((await worker.fetch(req(), env)).status, 401);
  assert.equal((await worker.fetch(req({ Authorization: 'Bearer errada' }), env)).status, 401);

  // demais caminhos vão para os arquivos estáticos
  const page = await worker.fetch(new Request('https://x.workers.dev/'), env);
  assert.equal(await page.text(), '<html>dash</html>');
});

test('StateStore: grava e lê o estado', async () => {
  const mem = new Map();
  const ctx = { storage: { get: async (k) => mem.get(k), put: async (k, v) => void mem.set(k, v) } };
  const store = new StateStore(ctx);
  assert.deepEqual(await (await store.fetch(new Request('https://state/load'))).json(), {});
  await store.fetch(new Request('https://state/save', { method: 'POST', body: JSON.stringify({ 1: { down: true } }) }));
  assert.deepEqual(await (await store.fetch(new Request('https://state/load'))).json(), { 1: { down: true } });
});
