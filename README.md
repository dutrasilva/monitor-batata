# Monitor Batata — Dashboard da estufa + alerta no Telegram

Um único projeto Cloudflare Workers (plano gratuito) que faz duas coisas:

1. **Hospeda o dashboard** (`public/index.html`) com HTTPS, acessível de qualquer lugar e de qualquer celular.
2. **Vigia os canais ThingSpeak 24 h por dia** (a cada minuto, no servidor — não depende de ninguém estar com a página aberta). Se o **Monitor 1 ou o Monitor 2 ficar mais de 5 minutos sem leitura válida**, avisa os contatos **pelo Telegram** (gratuito). Quando o monitor volta, manda um aviso de recuperação.

O aviso dispara uma vez por queda (sem repetir a cada minuto). Se os dois caírem juntos, vai uma mensagem só citando ambos. **SMS** (Twilio ou Zenvia) continua disponível como canal opcional e pode funcionar junto com o Telegram.

Exemplo do que chega no celular:

```
🚨 ALERTA — Estufa Batata
• Monitor 1 INOPERANTE: sem atualização há 6 min (última: 18/11 16:15)

Painel: https://monitor-batata.SEU-USUARIO.workers.dev

✅ Estufa Batata — recuperado
• Monitor 1 voltou a atualizar (ficou inoperante por 11 min)
```

## Como publicar

**Pelo GitHub (recomendado):** na Cloudflare, *Workers & Pages → Create → Import a repository*, escolha este repositório (branch `main`, comando de deploy `npx wrangler deploy`). A cada `git push` na `main` o site é republicado sozinho.

**Pela linha de comando:** com [Node.js 20+](https://nodejs.org) e uma conta gratuita na [Cloudflare](https://dash.cloudflare.com/sign-up):

```bash
npm install
npx wrangler login      # abre o navegador
npx wrangler deploy
```

No final aparece o endereço público, no formato `https://monitor-batata.SEU-USUARIO.workers.dev` — é esse o link que qualquer pessoa pode abrir (também no celular). Se o seu usuário for diferente, ajuste `DASHBOARD_URL` em `wrangler.jsonc` (é o link que vai nas mensagens).

## Configurar o Telegram (≈10 minutos)

**1. Criar o bot.** No Telegram, procure por **@BotFather** (o oficial, com selo azul), envie `/newbot` e responda às duas perguntas (nome e usuário, que termina em `bot`). Ele devolve o **token** (algo como `123456789:AAH...`). Trate-o como uma senha: não publique, não coloque no GitHub.

**2. Criar o grupo de alerta.** Crie um grupo no Telegram (ex.: "Alerta Estufa"), adicione as pessoas que devem ser avisadas e **adicione também o bot** (busque pelo usuário que você escolheu). Todos do grupo recebem cada alerta.

**3. Descobrir o ID do grupo.** Mande qualquer mensagem no grupo (ex.: `/start@usuario_do_seu_bot`) e abra no navegador, trocando `SEU_TOKEN`:

```
https://api.telegram.org/botSEU_TOKEN/getUpdates
```

Procure por `"chat":{"id":-100…` — esse número **negativo** (com o `-`) é o ID do grupo. Se a lista vier vazia, mande outra mensagem no grupo e recarregue.

> Para avisar uma pessoa direto (sem grupo), ela precisa abrir o bot e tocar em **Iniciar** (`/start`); o ID dela é um número positivo e aparece no mesmo `getUpdates`. Você pode listar vários destinos separados por vírgula.

**4. Guardar as chaves na Cloudflare (como *Secret*).** Em *Workers & Pages → monitor-batata → Settings → Variables and Secrets → Add*, tipo **Secret**:

| Nome | Valor |
|---|---|
| `TELEGRAM_BOT_TOKEN` | o token do BotFather |
| `TELEGRAM_CHAT_IDS` | o ID do grupo (ex.: `-1001234567890`); vários separados por vírgula |
| `ADMIN_TOKEN` | uma senha longa inventada por você (serve só para o teste abaixo) |

Pela linha de comando: `cp secrets.example.json secrets.json`, edite e rode `npx wrangler secret bulk secrets.json` (o `secrets.json` é ignorado pelo git).

**5. Testar.** Em um terminal (PowerShell no Windows):

```powershell
Invoke-RestMethod -Method Post -Uri https://monitor-batata.SEU-USUARIO.workers.dev/api/test-alert -Headers @{ Authorization = "Bearer SEU_ADMIN_TOKEN" }
```

ou, em Linux/Mac:

```bash
curl -X POST https://monitor-batata.SEU-USUARIO.workers.dev/api/test-alert -H "Authorization: Bearer SEU_ADMIN_TOKEN"
```

Resposta `sent: 1` e a mensagem "🧪 TESTE — Estufa Batata" chegando no grupo = tudo certo. Se vier `failed`, o motivo aparece junto (`chat not found` = ID errado ou bot fora do grupo; `Unauthorized` = token errado). Sem `ADMIN_TOKEN`, esse endpoint fica desligado.

Para testar o alerta de verdade: pare um dos monitores por mais de 5 minutos e acompanhe com `npx wrangler tail` (ou em *Observability* no painel).

**Se vazar o token:** no @BotFather use `/revoke`, gere outro e troque o secret.

**Se o grupo virar "supergrupo"** (acontece ao ativar certos recursos), o ID muda: repita o passo 3 e atualize `TELEGRAM_CHAT_IDS`.

## SMS (opcional)

Funciona junto com o Telegram ou sozinho. Basta cadastrar os secrets abaixo; sem `ALERT_PHONES` o SMS fica desligado.

| Secret | O que é |
|---|---|
| `ALERT_PHONES` | Contatos do SMS, separados por vírgula. Aceita `+5542999990001` ou `42999990001` (sem `+55`, assume Brasil). |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Credenciais da conta Twilio. |
| `TWILIO_FROM` | Número Twilio remetente (ou `TWILIO_MESSAGING_SERVICE_SID` no lugar). |

- **Twilio** (padrão). Conta de avaliação só envia para números previamente *verificados* e coloca um prefixo de teste na mensagem. No Brasil, SMS vindo de número estrangeiro pode ter o remetente trocado ou ser filtrado por operadoras — rode o teste com o celular de cada contato. Cobrado por mensagem.
- **Zenvia** (gateway brasileiro). Em `wrangler.jsonc` troque `"SMS_PROVIDER": "twilio"` por `"zenvia"` e use os secrets `ZENVIA_API_TOKEN` e `ZENVIA_FROM` (remetente cadastrado na conta) no lugar dos do Twilio.

O texto do SMS é só ASCII, para caber em 1 segmento.

## Ajustes (em `wrangler.jsonc` → `vars`; o deploy aplica)

| Variável | Padrão | Função |
|---|---|---|
| `CHANNEL_1`, `CHANNEL_2` | 3577085, 3577087 | IDs dos canais ThingSpeak. Deixe um vazio para vigiar só o outro. |
| `STALE_MINUTES` | 5 | Minutos sem leitura válida até alertar. Precisa ser maior que o intervalo entre envios dos sensores. |
| `REMINDER_MINUTES` | 0 | Se > 0, repete o aviso (como "LEMBRETE") enquanto o monitor continuar parado. 0 = não repete. |
| `SEND_RECOVERY` | true | `false` desliga o aviso de "voltou a atualizar". |
| `TIMEZONE` | America/Sao_Paulo | Fuso dos horários que aparecem nas mensagens. |
| `DASHBOARD_URL` | (link do Worker) | Link do painel incluído nas mensagens do Telegram. Vazio = sem link. |

Se algum canal for **privado**, cadastre também os secrets `READ_KEY_1` / `READ_KEY_2` (Read API Key do canal) para o verificador conseguir ler. O dashboard em si lê direto do navegador e só funciona com canais públicos.

## Detalhes de funcionamento

- "Sem atualização" usa o mesmo critério do dashboard: conta apenas leituras com temperatura e umidade numéricas e umidade entre 0 e 100. Sensor mandando campos vazios ou valores absurdos equivale a sensor parado.
- Se o próprio ThingSpeak ficar fora do ar ou der erro, o verificador **não** dispara alerta (não dá para saber o estado real): mantém o estado anterior e tenta de novo no minuto seguinte.
- Com mais de um canal ligado (Telegram + SMS), o alerta vai por todos; basta **um** destino receber para o alerta contar como enviado. Se **ninguém** receber (token errado, sem saldo etc.), o alerta continua pendente e é reenviado a cada minuto até chegar; o motivo fica nos logs.
- Se o Telegram estiver configurado pela metade (só token ou só IDs) ou com um ID inválido, o motivo aparece nos logs e no resultado do teste.
- O estado dos alertas fica em um Durable Object (consistência forte, plano gratuito), o que evita aviso duplicado.
- O token do Telegram nunca é gravado em log nem devolvido pelo endpoint de teste.
- O Worker consulta 2 canais por minuto — bem abaixo dos limites do plano gratuito da Cloudflare, do ThingSpeak e do Telegram.
- A tela "Configurar" do dashboard só altera o que aquele navegador mostra; não muda o que o verificador vigia (isso é `CHANNEL_1`/`CHANNEL_2`).

## Desenvolvimento

```bash
npm test          # 34 testes da lógica de alerta (sem rede)
npm run dev       # roda local; dispare a verificação em http://127.0.0.1:8787/__scheduled
npm run logs      # acompanha o Worker publicado
```

Atualizar o dashboard: edite `public/index.html` e faça commit na `main` (ou rode `npx wrangler deploy`).
