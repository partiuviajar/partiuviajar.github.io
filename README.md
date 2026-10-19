# ✈️ Radar de Voos

Monitora preços de passagens 24h (Google Flights + Aviasales) e avisa no WhatsApp,
no celular (app/PWA) e no Telegram quando o preço fica abaixo do normal.

## Como funciona

- **App** (`web/`): site instalável no celular, publicado de graça no GitHub Pages.
  Você cadastra até 10 rotas (data fixa ou mês inteiro), vê o calendário de preços,
  o histórico e os alertas.
- **Robô** (`bot/`): roda a cada 15 min no GitHub Actions. Cada rota é consultada no
  intervalo escolhido (padrão 3 h) ou na hora, pelo botão "Verificar agora".
- **Banco** (`supabase/schema.sql`): Supabase grátis guarda rotas, preços e alertas.

### Preço normal e alertas

- Cada data guarda o histórico dos últimos 30 dias; o **preço normal** é a mediana.
- Enquanto não há histórico (menos de 4 verificações), na rota "mês inteiro" o normal
  é a mediana dos preços de todos os dias do mês.
- Alerta quando o preço fica **X% abaixo do normal** (X escolhido no app), abaixo do
  **preço-alvo** opcional, ou quando bate o **menor preço já visto**.
- A mesma data só é avisada de novo se cair mais 3% (sem spam). Máximo de 3 datas por aviso.

### Fontes

| Fonte | Como | Observação |
|---|---|---|
| Google Flights | biblioteca `fast-flights` (lê a página) | sem API oficial; pode quebrar se o Google mudar o site |
| Aviasales | Travelpayouts Data API (token grátis) | preços em cache das buscas recentes; cobre o mês todo numa chamada |

Na rota "mês inteiro", o Google é consultado em até 8 dias por rodada (os mais baratos
segundo a Aviasales + um rodízio dos demais), para não ser bloqueado.

## Segredos do GitHub (Settings → Secrets and variables → Actions)

| Nome | O que é |
|---|---|
| `SUPABASE_SECRET_KEY` | chave **secret** do Supabase (Project Settings → API Keys) |
| `TRAVELPAYOUTS_TOKEN` | token da Travelpayouts |
| `CALLMEBOT_PHONE` | seu WhatsApp com DDI, ex. `+5521999998888` |
| `CALLMEBOT_APIKEY` | apikey recebida do CallMeBot |
| `VAPID_PRIVATE_KEY` | chave privada das notificações do app (gerada localmente em `.secrets/`) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | opcionais |

## Rodar o robô no computador

```bash
cd bot
uv run --python 3.12 --with-requirements requirements.txt python main.py --force
```
(precisa das mesmas variáveis de ambiente acima, mais `SUPABASE_URL`.)
