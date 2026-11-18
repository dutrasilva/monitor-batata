/**
 * Monitor Batata — Cloudflare Worker
 *
 *  1) Serve o dashboard (arquivos da pasta /public, via "assets").
 *  2) A cada minuto (Cron Trigger) confere se os canais ThingSpeak do Monitor 1
 *     e do Monitor 2 continuam recebendo leituras válidas. Se algum ficar mais de
 *     STALE_MINUTES (padrão: 5) sem atualização, envia SMS aos contatos de
 *     ALERT_PHONES. Quando o monitor volta, envia um aviso de recuperação.
 *
 * O estado (quem está inoperante e se o SMS já foi enviado) fica em um Durable
 * Object, que tem consistência forte — assim o mesmo alerta não é enviado duas vezes.
 */

const THINGSPEAK_BASE = 'https://api.thingspeak.com';
const TWILIO_BASE = 'https://api.twilio.com';
const ZENVIA_BASE = 'https://api.zenvia.com';

/* ----------------------------------------------------------------------------
 * Configuração
 * ------------------------------------------------------------------------- */

const positive = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const nonNegative = (v, fallback) => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function readConfig(env) {
  const monitors = [1, 2]
    .map((i) => ({
      id: String(i),
      name: `Monitor ${i}`,
      channel: String(env[`CHANNEL_${i}`] ?? '').trim(),
      key: String(env[`READ_KEY_${i}`] ?? '').trim(),
    }))
    .filter((m) => /^\d+$/.test(m.channel));

  return {
    monitors,
    staleMs: positive(env.STALE_MINUTES, 5) * 60_000,
    reminderMs: nonNegative(env.REMINDER_MINUTES, 0) * 60_000,
    sendRecovery: String(env.SEND_RECOVERY ?? 'true').toLowerCase() !== 'false',
    tz: env.TIMEZONE || 'America/Sao_Paulo',
  };
}

/* ----------------------------------------------------------------------------
 * Leitura do ThingSpeak
 * ------------------------------------------------------------------------- */

const toNumber = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

/** Mesmo critério do dashboard: temperatura e umidade numéricas, umidade entre 0 e 100. */
export function isValidReading(feed) {
  const temp = toNumber(feed.field1);
  const hum = toNumber(feed.field2);
  return Number.isFinite(temp) && Number.isFinite(hum) && hum >= 0 && hum <= 100;
}

/** Retorna o horário (ms) da última leitura válida do canal, ou null se não houver. */
async function readLastValid(env, monitor, fetchFn) {
  const qs = new URLSearchParams({ results: '20' });
  if (monitor.key) qs.set('api_key', monitor.key);
  const base = env.THINGSPEAK_BASE || THINGSPEAK_BASE;
  const resp = await fetchFn(`${base}/channels/${monitor.channel}/feeds.json?${qs}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`ThingSpeak HTTP ${resp.status}`);
  const body = await resp.json().catch(() => null);
  if (!body || !Array.isArray(body.feeds)) throw new Error('resposta inválida do ThingSpeak');

  let last = null;
  for (const feed of body.feeds) {
    const t = Date.parse(feed.created_at);
    if (Number.isFinite(t) && isValidReading(feed) && (last === null || t > last)) last = t;
  }
  return last;
}

/* ----------------------------------------------------------------------------
 * Textos dos SMS (somente ASCII: cabe em 1 segmento GSM-7 e evita problemas de acento)
 * ------------------------------------------------------------------------- */

function fmtDateTime(ts, tz) {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: tz,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ts));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('day')}/${get('month')} ${hour}:${get('minute')}`;
}

function fmtDuration(ms) {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h >= 48) return `${Math.floor(h / 24)} dias`;
  const m = min % 60;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

export function alertText(items, tz) {
  const lines = items.map(({ monitor, lastAt, age }) =>
    lastAt === null
      ? `${monitor.name} INOPERANTE - sem leitura valida recente`
      : `${monitor.name} INOPERANTE - sem atualizacao ha ${fmtDuration(age)} (ultimo: ${fmtDateTime(lastAt, tz)})`,
  );
  const prefix = items.some((i) => !i.reminder) ? 'ALERTA' : 'LEMBRETE';
  return `${prefix} Estufa Batata: ${lines.join('; ')}.`;
}

export function recoveryText(items) {
  const lines = items.map(
    ({ monitor, downFor }) => `${monitor.name} voltou a atualizar (inoperante por ${fmtDuration(downFor)})`,
  );
  return `OK Estufa Batata: ${lines.join('; ')}.`;
}

/* ----------------------------------------------------------------------------
 * Envio de SMS (Twilio ou Zenvia)
 * ------------------------------------------------------------------------- */

/** Aceita +5542999998888, 5542999998888 ou 42999998888 (assume Brasil) e devolve E.164. */
export function normalizePhone(raw) {
  const s = String(raw ?? '').trim();
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;
  if (s.startsWith('+')) return `+${digits}`;
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
  return `+${digits}`;
}

const maskPhone = (p) => p.replace(/\d(?=\d{4})/g, '*');

export function recipients(env) {
  return [...new Set(String(env.ALERT_PHONES ?? '').split(/[,;\s]+/).map(normalizePhone).filter(Boolean))];
}

const providerName = (env) => String(env.SMS_PROVIDER || 'twilio').toLowerCase();

function providerProblems(env) {
  const p = providerName(env);
  let missing = [];
  if (p === 'twilio') {
    missing = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'].filter((k) => !env[k]);
    if (!env.TWILIO_FROM && !env.TWILIO_MESSAGING_SERVICE_SID) missing.push('TWILIO_FROM (ou TWILIO_MESSAGING_SERVICE_SID)');
  } else if (p === 'zenvia') {
    missing = ['ZENVIA_API_TOKEN', 'ZENVIA_FROM'].filter((k) => !env[k]);
  } else {
    return [`SMS_PROVIDER inválido: "${p}" (use twilio ou zenvia)`];
  }
  return missing.length ? [`faltam configurações do ${p}: ${missing.join(', ')}`] : [];
}

async function sendOne(env, to, text, fetchFn) {
  const p = providerName(env);
  let resp;
  if (p === 'twilio') {
    const sid = env.TWILIO_ACCOUNT_SID;
    const form = new URLSearchParams({ To: to, Body: text });
    if (env.TWILIO_MESSAGING_SERVICE_SID) form.set('MessagingServiceSid', env.TWILIO_MESSAGING_SERVICE_SID);
    else form.set('From', env.TWILIO_FROM);
    resp = await fetchFn(`${env.SMS_API_BASE || TWILIO_BASE}/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${sid}:${env.TWILIO_AUTH_TOKEN}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
  } else {
    resp = await fetchFn(`${env.SMS_API_BASE || ZENVIA_BASE}/v2/channels/sms/messages`, {
      method: 'POST',
      headers: { 'X-API-TOKEN': env.ZENVIA_API_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.ZENVIA_FROM,
        to: to.replace(/^\+/, ''),
        contents: [{ type: 'text', text }],
      }),
      signal: AbortSignal.timeout(15_000),
    });
  }
  if (!resp.ok) {
    const detail = (await resp.text().catch(() => '')).slice(0, 200).replace(/\s+/g, ' ');
    throw new Error(`HTTP ${resp.status} ${detail}`.trim());
  }
}

/** Envia o texto a todos os contatos. Devolve quantos receberam e os erros (sem dados sensíveis). */
export async function notifyAll(env, text, fetchFn = fetch) {
  const phones = recipients(env);
  if (phones.length === 0) return { sent: 0, failed: ['ALERT_PHONES não configurado'] };
  const problems = providerProblems(env);
  if (problems.length) return { sent: 0, failed: problems };

  const results = await Promise.allSettled(phones.map((to) => sendOne(env, to, text, fetchFn)));
  let sent = 0;
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') sent++;
    else failed.push(`${maskPhone(phones[i])}: ${r.reason?.message ?? r.reason}`);
  });
  return { sent, failed };
}

/* ----------------------------------------------------------------------------
 * Verificação periódica
 * ------------------------------------------------------------------------- */

/**
 * Lê os dois canais, compara com o estado salvo e envia os SMS necessários.
 * `store` precisa ter load() e save(obj). Os demais parâmetros existem para os testes.
 */
export async function runCheck(env, { store, now = Date.now(), fetchFn = fetch } = {}) {
  const cfg = readConfig(env);
  if (cfg.monitors.length === 0) {
    console.warn('Nenhum canal configurado (CHANNEL_1 / CHANNEL_2).');
    return;
  }

  const state = (await store.load()) ?? {};
  const next = structuredClone(state);

  const checks = await Promise.all(
    cfg.monitors.map(async (monitor) => {
      try {
        return { monitor, lastAt: await readLastValid(env, monitor, fetchFn) };
      } catch (e) {
        return { monitor, error: e.message };
      }
    }),
  );

  const alerts = [];
  const recoveries = [];

  for (const c of checks) {
    if (c.error) {
      // Não sabemos o estado real: mantém o que já estava salvo e tenta de novo no próximo minuto.
      console.warn(`${c.monitor.name}: falha ao consultar o ThingSpeak (${c.error}); estado mantido.`);
      continue;
    }
    const age = c.lastAt === null ? Infinity : now - c.lastAt;
    const down = age > cfg.staleMs;
    const prev = next[c.monitor.id];

    if (down) {
      const st = prev?.down ? prev : { down: true, since: now, lastDataAt: c.lastAt, alerted: false, notifiedAt: 0 };
      next[c.monitor.id] = st;
      const reminderDue = st.alerted && cfg.reminderMs > 0 && now - st.notifiedAt >= cfg.reminderMs;
      if (!st.alerted || reminderDue) {
        alerts.push({ monitor: c.monitor, st, lastAt: c.lastAt, age, reminder: st.alerted });
      }
    } else if (prev?.down) {
      if (prev.alerted) recoveries.push({ monitor: c.monitor, downFor: now - (prev.lastDataAt ?? prev.since) });
      delete next[c.monitor.id];
    }
  }

  if (alerts.length) {
    const res = await notifyAll(env, alertText(alerts, cfg.tz), fetchFn);
    if (res.sent > 0) {
      for (const a of alerts) {
        a.st.alerted = true;
        a.st.notifiedAt = now;
      }
      if (res.failed.length) console.warn(`SMS enviado, mas com falhas: ${res.failed.join(' | ')}`);
    } else {
      // Nenhum contato recebeu: mantém "alerted=false" para tentar de novo no próximo minuto.
      console.error(`SMS de alerta NÃO enviado: ${res.failed.join(' | ')}`);
    }
  }

  if (recoveries.length && cfg.sendRecovery) {
    const res = await notifyAll(env, recoveryText(recoveries), fetchFn);
    if (res.sent === 0) console.error(`SMS de recuperação não enviado: ${res.failed.join(' | ')}`);
  }

  if (JSON.stringify(next) !== JSON.stringify(state)) await store.save(next);
}

/* ----------------------------------------------------------------------------
 * Durable Object: guarda o estado dos alertas
 * ------------------------------------------------------------------------- */

export class StateStore {
  constructor(ctx) {
    this.ctx = ctx;
  }
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/save' && request.method === 'POST') {
      await this.ctx.storage.put('state', await request.json());
      return new Response('ok');
    }
    return Response.json((await this.ctx.storage.get('state')) ?? {});
  }
}

function durableStore(env) {
  const stub = env.STATE.get(env.STATE.idFromName('estufa'));
  return {
    async load() {
      return (await stub.fetch('https://state/load')).json();
    },
    async save(obj) {
      await stub.fetch('https://state/save', { method: 'POST', body: JSON.stringify(obj) });
    },
  };
}

/* ----------------------------------------------------------------------------
 * Endpoint de teste de SMS (opcional, protegido por ADMIN_TOKEN)
 * ------------------------------------------------------------------------- */

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function handleTestSms(request, env, fetchFn) {
  if (!env.ADMIN_TOKEN) return new Response('Not found', { status: 404 });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  if (!safeEqual(request.headers.get('Authorization') ?? '', `Bearer ${env.ADMIN_TOKEN}`)) {
    return new Response('Unauthorized', { status: 401 });
  }
  const cfg = readConfig(env);
  const res = await notifyAll(env, `TESTE Estufa Batata: SMS de teste enviado em ${fmtDateTime(Date.now(), cfg.tz)}.`, fetchFn);
  return Response.json(res, { status: res.sent > 0 ? 200 : 502 });
}

/* ----------------------------------------------------------------------------
 * Entradas do Worker
 * ------------------------------------------------------------------------- */

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/test-sms') return handleTestSms(request, env, fetch);
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runCheck(env, { store: durableStore(env) }));
  },
};
