# Cloudflare front door

Objetivo: publicar el dashboard de forma privada y protegida, sin abrir puertos internos.

## Recomendacion

Usar Cloudflare Tunnel hacia `http://127.0.0.1:4000` en el VPS.

No publiques directamente:

- Postgres `5432/5433`
- Redis `6379/6380`
- Health ports internos de workers

## Politica sugerida

- Subdominio: `sports.tudominio.com`
- Cloudflare Access obligatorio con correo autorizado
- TLS activo
- WAF gestionado
- Rate limiting para `/api/*`

## Ejemplo conceptual de tunnel

```bash
cloudflared tunnel create sports-data-hub
cloudflared tunnel route dns sports-data-hub sports.tudominio.com
cloudflared tunnel run sports-data-hub
```

Config esperada:

```yaml
ingress:
  - hostname: sports.tudominio.com
    service: http://127.0.0.1:4000
  - service: http_status:404
```

## Candados del proyecto

Cloudflare no reemplaza los guardrails internos:

- dinero real apagado
- Kelly apagado
- Telegram automatico apagado
- `REAL_CANDIDATE = 0`

## Archivo ejemplo

Se agrego `deploy/cloudflare/config.example.yml` como referencia para un tunnel administrado por archivo.

Para el flujo recomendado con token desde Docker Compose, basta con crear el tunnel en Cloudflare Zero Trust y guardar el token en `.env`:

```env
CLOUDFLARE_TUNNEL_TOKEN=...
```

Luego iniciar el perfil `edge`:

```bash
docker compose --profile edge up -d cloudflared
```

El servicio interno recomendado es:

```text
http://engine-node:3000
```