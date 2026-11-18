# Monitor Batata — Dashboard da estufa + alerta por SMS

Um único projeto Cloudflare Workers (plano gratuito) que faz duas coisas:

1. **Hospeda o dashboard** (`public/index.html`) com HTTPS, acessível de qualquer lugar e de qualquer celular.
2. **Vigia os canais ThingSpeak 24 h por dia** (a cada minuto, no servidor — não depende de ninguém estar com a página aberta). Se o **Monitor 1 ou o Monitor 2 ficar mais de 5 minutos sem leitura válida**, envia um SMS aos contatos cadastrados. Quando o monitor volta, envia um aviso de recuperação.

O SMS dispara uma vez por queda (sem repetir a cada minuto). Se os dois caírem juntos, vai uma mensagem só citando ambos.

Exemplo do que chega no celular:

```
ALERTA Estufa Batata: Monitor 1 INOPERANTE - sem atualizacao ha 6 min (ultimo: 18/11 16:15).
OK Estufa Batata: Monitor 1 voltou a atualizar (inoperante por 11 min).
```

## Como publicar (≈10 minutos)

Pré-requisitos: [Node.js 20+](https://nodejs.org), uma conta gratuita na [Cloudflare](https://dash.cloudflare.com/sign-up) e uma conta em um provedor de SMS (Twilio ou Zenvia — veja abaixo).

```bash
cd monitor-batata
npm install

# 1) entra na sua conta Cloudflare (abre o navegador)
npx wrangler login

# 2) publica o site + o verificador de 1 em 1 minuto
npx wrangler deploy
```

No final do `deploy` aparece o endereço público, no formato
`https://monitor-batata.SEU-USUARIO.workers.dev` — é esse o link que qualquer pessoa pode abrir (também no celular).
Se quiser um domínio próprio, adicione em *Workers & Pages → monitor-batata → Settings → Domains & Routes*.

### Cadastrar os contatos e as credenciais do SMS

Telefones e chaves **não** ficam no código: vão como *secrets* da Cloudflare.

```bash
cp secrets.example.json secrets.json      # edite com seus dados (o arquivo é ignorado pelo git)
npx wrangler secret bulk secrets.json
```

| Chave | O que é |
|---|---|
| `ALERT_PHONES` | Contatos que recebem o SMS, separados por vírgula. Aceita `+5542999990001` ou `42999990001` (sem `+55`, assume Brasil). |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Credenciais da conta Twilio. |
| `TWILIO_FROM` | Número Twilio remetente (ou use `TWILIO_MESSAGING_SERVICE_SID` no lugar). |
| `ADMIN_TOKEN` | Senha para o endpoint de teste (invente uma longa). Opcional. |

Para trocar os contatos depois: edite `ALERT_PHONES` no `secrets.json` e rode `npx wrangler secret bulk secrets.json` de novo.

### Testar o SMS antes de depender dele

```bash
curl -X POST https://monitor-batata.SEU-USUARIO.workers.dev/api/test-sms \
     -H "Authorization: Bearer SEU_ADMIN_TOKEN"
```

Resposta `{"sent":2,"failed":[]}` = chegou para os dois contatos. Se vier `failed`, a mensagem diz o motivo (credencial errada, número não verificado etc.). Sem `ADMIN_TOKEN` configurado, esse endpoint fica desligado.

Para testar o alerta de verdade: pare um dos monitores por mais de 5 minutos e acompanhe com `npx wrangler tail`.

## Escolhendo o provedor de SMS

- **Twilio** (padrão). Conta de avaliação só envia para números previamente *verificados* e coloca um prefixo de teste na mensagem; para enviar a qualquer número é preciso fazer upgrade. No Brasil, SMS vindo de número estrangeiro pode ter o remetente trocado por código curto ou ser filtrado por operadoras — por isso rode o teste acima com o celular de cada contato.
- **Zenvia** (gateway brasileiro). Em `wrangler.jsonc` troque `"SMS_PROVIDER": "twilio"` por `"zenvia"`, rode `npx wrangler deploy` e use estes secrets no lugar dos do Twilio:

  ```json
  { "ALERT_PHONES": "+5542999990001,+5542999990002", "ZENVIA_API_TOKEN": "...", "ZENVIA_FROM": "identificador-do-remetente", "ADMIN_TOKEN": "..." }
  ```

  `ZENVIA_FROM` é o remetente cadastrado na sua conta Zenvia.

## Ajustes (em `wrangler.jsonc` → `vars`, depois `npx wrangler deploy`)

| Variável | Padrão | Função |
|---|---|---|
| `CHANNEL_1`, `CHANNEL_2` | 3577085, 3577087 | IDs dos canais ThingSpeak. Deixe um vazio para vigiar só o outro. |
| `STALE_MINUTES` | 5 | Minutos sem leitura válida até alertar. Precisa ser maior que o intervalo entre envios dos sensores. |
| `REMINDER_MINUTES` | 0 | Se > 0, repete o SMS (como "LEMBRETE") enquanto o monitor continuar parado. 0 = não repete. |
| `SEND_RECOVERY` | true | `false` desliga o SMS de "voltou a atualizar". |
| `TIMEZONE` | America/Sao_Paulo | Fuso dos horários que aparecem no SMS. |

Se algum canal for **privado**, cadastre também os secrets `READ_KEY_1` / `READ_KEY_2` (Read API Key do canal) para o verificador conseguir ler. O dashboard em si lê direto do navegador e só funciona com canais públicos.

## Detalhes de funcionamento

- "Sem atualização" usa o mesmo critério do dashboard: conta apenas leituras com temperatura e umidade numéricas e umidade entre 0 e 100. Sensor mandando campos vazios ou valores absurdos equivale a sensor parado.
- Se o próprio ThingSpeak ficar fora do ar ou der erro, o verificador **não** dispara alerta (não dá para saber o estado real): mantém o estado anterior e tenta de novo no minuto seguinte. O erro aparece em `npx wrangler tail`.
- Se o SMS falhar para todos os contatos (credencial errada, sem saldo), o alerta continua pendente e é reenviado no minuto seguinte, até chegar a pelo menos um.
- O estado dos alertas fica em um Durable Object (consistência forte, plano gratuito), o que evita SMS duplicado.
- O Worker consulta 2 canais por minuto — bem abaixo dos limites do plano gratuito da Cloudflare e do ThingSpeak.
- A tela "Configurar" do dashboard só altera o que aquele navegador mostra; não muda o que o verificador vigia (isso é `CHANNEL_1`/`CHANNEL_2`).

## Desenvolvimento

```bash
npm test          # 22 testes da lógica de alerta (sem rede)
npm run dev       # roda local; dispare a verificação em http://127.0.0.1:8787/__scheduled
npm run logs      # acompanha o Worker publicado
```

Atualizar o dashboard: edite `public/index.html` e rode `npx wrangler deploy`.
