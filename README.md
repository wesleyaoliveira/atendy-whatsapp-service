# atendy-whatsapp-service

Microserviço Node.js + Baileys que gerencia as sessões WhatsApp do AtendyApp.
O usuário final nunca vê esse serviço — o AtendyApp fala com ele via HTTP.

## Arquitetura

```
AtendyApp (Lovable Cloud)  ──HTTPS──▶  atendy-whatsapp-service (esta VPS)  ──WebSocket──▶  WhatsApp
                            ◀──webhook──
```

- Multi-sessão (uma por usuário do SaaS)
- Persistência de auth no Postgres → sobrevive a reinícios
- Reconexão automática com backoff exponencial
- Restaura todas as sessões ao iniciar
- Webhooks assinados com Bearer token

## Deploy em 5 minutos

### 1. Provisione uma VPS
Hetzner CX11 (~€4/mês), Contabo, DigitalOcean, ou qualquer Linux com Docker.

### 2. Instale Docker
```bash
curl -fsSL https://get.docker.com | sh
```

### 3. Clone e configure
```bash
git clone <este-repo> /opt/wa && cd /opt/wa
cp .env.example .env
nano .env   # gere SERVICE_TOKEN aleatório (ex: openssl rand -hex 32)
```

### 4. Suba
```bash
docker compose up -d --build
docker compose logs -f wa
```

Healthcheck: `curl http://SEU_IP:3000/health` → `{"ok":true}`.

### 5. Conecte ao AtendyApp
Aponte um domínio com HTTPS para a VPS (use Caddy/Nginx + Let's Encrypt) e
defina no AtendyApp os secrets:

- `WA_SERVICE_URL` = `https://wa.seudominio.com`
- `WA_SERVICE_TOKEN` = mesmo valor de `SERVICE_TOKEN` do `.env`

Pronto. O botão "Conectar WhatsApp" agora funciona de ponta a ponta.

## Caddy reverso (opcional, recomendado)

`/etc/caddy/Caddyfile`:
```
wa.seudominio.com {
  reverse_proxy localhost:3000
}
```

## API

Todos os endpoints exigem header `Authorization: Bearer $SERVICE_TOKEN`.

### `POST /sessions`
```json
{ "sessionId": "u_abc", "webhookUrl": "https://app.com/api/public/webhooks/wa/u_abc" }
```
→ `{ "sessionId": "u_abc", "status": "qr", "qr": "data:image/png;base64,..." }`

### `GET /sessions/:id`
→ `{ "sessionId":"u_abc","status":"connected","phone":"5511...","profileName":"...","profilePicUrl":"..." }`

### `POST /sessions/:id/restart`
Força reconexão.

### `DELETE /sessions/:id`
Logout + remove credenciais.

### `POST /sessions/:id/send`
```json
{ "to": "5511999999999", "text": "Olá!" }
```

### Webhooks emitidos (POST → `webhookUrl`)
Header: `Authorization: Bearer $SERVICE_TOKEN`

```json
{ "event": "qr", "data": { "qr": "data:image/png;base64,..." } }
{ "event": "connection.update", "data": { "status": "connected", "phone": "5511...", "profileName": "...", "profilePicUrl": "..." } }
{ "event": "connection.update", "data": { "status": "disconnected" } }
{ "event": "messages.upsert", "data": { "messages": [{ "from": "5511...@s.whatsapp.net", "fromMe": false, "id": "...", "text": "...", "pushName": "..." }] } }
```

## Atualizações
```bash
cd /opt/wa && git pull && docker compose up -d --build
```

## Logs
```bash
docker compose logs -f wa
```

## Backup do Postgres
```bash
docker compose exec postgres pg_dump -U wa wa > backup-$(date +%F).sql
```
