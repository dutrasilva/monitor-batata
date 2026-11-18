import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { runCheck, normalizePhone, StateStore, notifyAll, telegramChats } from '../src/worker.js';

const MIN = 60_000;
const NOW = Date.parse('2026-11-18T19:30:00Z'); // 16:30 em São Paulo

const feed = (ts, { t = '24.5', h = '70' } = {}) => ({
  created_at: new Date(ts).toISOString(),
  entry_id: ts,
  field1: t,
  field2: h,
});

/** ThingSpeak, Telegram e provedor de SMS simulados. */
function makeWorld({ channels = {}, smsFail = () => false, tgFail = () => false } = {}) {
  const sms = [];
  const tg = [];
  const fetchFn = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('thingspeak')) {
      const id = u.match(/channels\/(\d+)\//)[1];
      const data = channels[id];
      if (data instanceof Error) throw data;
      if (typeof data === 'number') return new Response('{}', { status: data });
      return Response.json({ channel: { id }, feeds: data });
    }
    if (u.includes('api.telegram.org')) {
      const j = JSON.parse(init.body);
      const token = u.match(/\/bot([^/]+)\/sendMessage$/)[1];
      const fail = tgFail(j.chat_id, token);
      if (fail) {
        return Response.json({ ok: false, error_code: 400, description: fail === true ? 'Bad Request: chat not found' : fail }, { status: 400 });
      }
      tg.push({ chat: j.chat_id, text: j.text, token, url: u, init });
      return Response.json({ ok: true, result: {} });
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
  return { sms, tg, fetchFn };
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

const tgEnv = { CHANNEL_1: '111', CHANNEL_2: '222', TELEGRAM_BOT_TOKEN: '123456:ABC-token', TELEGRAM_CHAT_IDS: '-1001234567890' };

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

test('Telegram: alerta no grupo, texto com acentos e sem repetir a cada minuto', async () => {
  const { sms, tg, fetchFn } = makeWorld({ channels: { 111: [feed(NOW - 7 * MIN)], 222: fresh() } });
  const store = makeStore();
  await runCheck(tgEnv, { store, now: NOW, fetchFn });
  await runCheck(tgEnv, { store, now: NOW + MIN, fetchFn });

  assert.equal(sms.length, 0, 'sem ALERT_PHONES não há SMS');
  assert.equal(tg.length, 1, 'uma mensagem para o grupo, sem repetir');
  assert.equal(tg[0].chat, '-1001234567890');
  assert.equal(tg[0].text, '🚨 ALERTA — Estufa Batata\n• Monitor 1 INOPERANTE: sem atualização há 7 min (última: 18/11 16:23)');
  assert.equal(tg[0].url, 'https://api.telegram.org/bot123456:ABC-token/sendMessage');
  assert.equal(store.data['1'].alerted, true);
});

test('Telegram: Monitor 2 e os dois juntos, com o link do painel', async () => {
  const env = { ...tgEnv, DASHBOARD_URL: 'https://monitor-batata.exemplo.workers.dev' };
  const only2 = makeWorld({ channels: { 111: fresh(), 222: [feed(NOW - 9 * MIN)] } });
  await runCheck(env, { store: makeStore(), now: NOW, fetchFn: only2.fetchFn });
  assert.match(only2.tg[0].text, /Monitor 2 INOPERANTE/);
  assert.doesNotMatch(only2.tg[0].text, /Monitor 1/);
  assert.match(only2.tg[0].text, /\nPainel: https:\/\/monitor-batata\.exemplo\.workers\.dev$/);

  const both = makeWorld({ channels: { 111: [feed(NOW - 8 * MIN)], 222: [feed(NOW - 10 * MIN)] } });
  await runCheck(env, { store: makeStore(), now: NOW, fetchFn: both.fetchFn });
  assert.equal(both.tg.length, 1);
  assert.match(both.tg[0].text, /Monitor 1 INOPERANTE.*\n• Monitor 2 INOPERANTE/);
});

test('Telegram: vários destinos (grupo + pessoa), duplicados são ignorados', async () => {
  const env = { ...tgEnv, TELEGRAM_CHAT_IDS: '-1001234567890, 987654321;987654321' };
  const { tg, fetchFn } = makeWorld({ channels: { 111: [feed(NOW - 7 * MIN)], 222: fresh() } });
  await runCheck(env, { store: makeStore(), now: NOW, fetchFn });
  assert.deepEqual(tg.map((m) => m.chat).sort(), ['-1001234567890', '987654321']);
});

test('Telegram: aviso de recuperação e SEND_RECOVERY=false', async () => {
  const store = makeStore();
  await runCheck(tgEnv, { store, now: NOW, fetchFn: makeWorld({ channels: { 111: [feed(NOW - 7 * MIN)], 222: fresh() } }).fetchFn });
  const later = NOW + 4 * MIN;
  const ok = makeWorld({ channels: { 111: fresh(later), 222: fresh(later) } });
  await runCheck(tgEnv, { store, now: later, fetchFn: ok.fetchFn });
  assert.equal(ok.tg.length, 1);
  assert.equal(ok.tg[0].text, '✅ Estufa Batata — recuperado\n• Monitor 1 voltou a atualizar (ficou inoperante por 11 min)');
  assert.deepEqual(store.data, {});

  const env = { ...tgEnv, SEND_RECOVERY: 'false' };
  const store2 = makeStore();
  await runCheck(env, { store: store2, now: NOW, fetchFn: makeWorld({ channels: { 111: [feed(NOW - 7 * MIN)], 222: fresh() } }).fetchFn });
  const ok2 = makeWorld({ channels: { 111: fresh(later), 222: fresh(later) } });
  await runCheck(env, { store: store2, now: later, fetchFn: ok2.fetchFn });
  assert.equal(ok2.tg.length, 0);
});

test('Telegram: lembrete opcional usa o prefixo LEMBRETE', async () => {
  const env = { ...tgEnv, REMINDER_MINUTES: '60' };
  const last = NOW - 7 * MIN;
  const store = makeStore();
  await runCheck(env, { store, now: NOW, fetchFn: makeWorld({ channels: { 111: [feed(last)], 222: fresh() } }).fetchFn });
  const w = makeWorld({ channels: { 111: [feed(last)], 222: fresh(NOW + 61 * MIN) } });
  await runCheck(env, { store, now: NOW + 61 * MIN, fetchFn: w.fetchFn });
  assert.equal(w.tg.length, 1);
  assert.match(w.tg[0].text, /^⏰ LEMBRETE — Estufa Batata\n• Monitor 1 INOPERANTE/);
});

test('Telegram falhando (chat errado): fica pendente, tenta de novo e depois não duplica', async () => {
  const channels = { 111: [feed(NOW - 7 * MIN)], 222: fresh() };
  const store = makeStore();
  const broken = makeWorld({ channels, tgFail: () => true });
  await runCheck(tgEnv, { store, now: NOW, fetchFn: broken.fetchFn });
  assert.equal(broken.tg.length, 0);
  assert.equal(store.data['1'].alerted, false);

  const working = makeWorld({ channels: { 111: [feed(NOW - 7 * MIN)], 222: fresh(NOW + MIN) } });
  await runCheck(tgEnv, { store, now: NOW + MIN, fetchFn: working.fetchFn });
  assert.equal(working.tg.length, 1);
  assert.equal(store.data['1'].alerted, true);

  const again = makeWorld({ channels: { 111: [feed(NOW - 7 * MIN)], 222: fresh(NOW + 2 * MIN) } });
  await runCheck(tgEnv, { store, now: NOW + 2 * MIN, fetchFn: again.fetchFn });
  assert.equal(again.tg.length, 0);
});

test('Telegram + SMS configurados: avisa pelos dois; se um falha, o outro basta', async () => {
  const env = { ...baseEnv, ...tgEnv };
  const ok = makeWorld({ channels: { 111: [feed(NOW - 7 * MIN)], 222: fresh() } });
  await runCheck(env, { store: makeStore(), now: NOW, fetchFn: ok.fetchFn });
  assert.equal(ok.tg.length, 1);
  assert.equal(ok.sms.length, 2);
  assert.match(ok.sms[0].body, /^[\x20-\x7e]+$/, 'SMS continua ASCII');

  const tgDown = makeWorld({ channels: { 111: [feed(NOW - 7 * MIN)], 222: fresh() }, tgFail: () => true });
  const store = makeStore();
  await runCheck(env, { store, now: NOW, fetchFn: tgDown.fetchFn });
  assert.equal(tgDown.sms.length, 2);
  assert.equal(store.data['1'].alerted, true, 'o SMS entregou, então não repete');
});

test('Telegram: configuração incompleta ou inválida não quebra e fica pendente', async () => {
  const channels = { 111: [feed(NOW - 7 * MIN)], 222: fresh() };
  const bad = [
    { ...tgEnv, TELEGRAM_CHAT_IDS: '' },
    { ...tgEnv, TELEGRAM_BOT_TOKEN: '' },
    { ...tgEnv, TELEGRAM_CHAT_IDS: 'meu grupo' },
  ];
  for (const env of bad) {
    const { tg, fetchFn } = makeWorld({ channels });
    const store = makeStore();
    await runCheck(env, { store, now: NOW, fetchFn });
    assert.equal(tg.length, 0);
    assert.equal(store.data['1'].alerted, false);
  }
});

test('Telegram: o token nunca vaza nas mensagens de erro', async () => {
  const fetchFn = async (url) => {
    throw new Error(`falha de rede em ${url}`);
  };
  const res = await notifyAll(tgEnv, 'oi', fetchFn);
  assert.equal(res.sent, 0);
  assert.ok(res.failed.length > 0);
  assert.ok(!JSON.stringify(res).includes('ABC-token'));

  const apiErr = makeWorld({ tgFail: () => 'Unauthorized' });
  const res2 = await notifyAll(tgEnv, 'oi', apiErr.fetchFn);
  assert.match(res2.failed[0], /^Telegram: chat -\*+7890: HTTP 400 Unauthorized$/);
  assert.ok(!JSON.stringify(res2).includes('ABC-token'));
});

test('nenhum canal configurado: relata o motivo e não envia nada', async () => {
  const res = await notifyAll({ CHANNEL_1: '111' }, 'oi', async () => assert.fail('não deveria chamar a rede'));
  assert.equal(res.sent, 0);
  assert.match(res.failed[0], /nenhum canal de aviso configurado/);
});

test('telegramChats: aceita ids de grupo/pessoa e @canal; conta os inválidos', () => {
  assert.deepEqual(telegramChats({ TELEGRAM_CHAT_IDS: ' -100123 , 42;@meucanal\n42 ' }), { chats: ['-100123', '42', '@meucanal'], invalid: 0 });
  assert.deepEqual(telegramChats({ TELEGRAM_CHAT_IDS: '123abc, ok, 7' }), { chats: ['7'], invalid: 2 });
  assert.deepEqual(telegramChats({}), { chats: [], invalid: 0 });
});

test('endpoint /api/test-alert: envia o teste pelo Telegram (e /api/test-sms continua valendo)', async () => {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return Response.json({ ok: true, result: {} });
  };
  try {
    const env = { ...tgEnv, ADMIN_TOKEN: 's3nha', ASSETS: { fetch: async () => new Response('x') } };
    for (const path of ['/api/test-alert', '/api/test-sms']) {
      const r = await worker.fetch(new Request(`https://x.workers.dev${path}`, { method: 'POST', headers: { Authorization: 'Bearer s3nha' } }), env);
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.equal(j.sent, 1);
      assert.deepEqual(j.failed, []);
      assert.ok(!JSON.stringify(j).includes('ABC-token'));
    }
    assert.equal(sent.length, 2);
    assert.match(sent[0].body.text, /^🧪 TESTE — Estufa Batata/);

    // sem nenhum canal configurado devolve 502 com o motivo
    const bare = { CHANNEL_1: '111', ADMIN_TOKEN: 's3nha', ASSETS: env.ASSETS };
    const r2 = await worker.fetch(new Request('https://x.workers.dev/api/test-alert', { method: 'POST', headers: { Authorization: 'Bearer s3nha' } }), bare);
    assert.equal(r2.status, 502);
  } finally {
    globalThis.fetch = realFetch;
  }
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
