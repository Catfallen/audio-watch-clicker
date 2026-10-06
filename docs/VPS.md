# Guia da VPS

Instalação do servidor numa VPS que **já tem nginx, certbot e pm2**. O servidor roda na porta interna **3367**, gerenciado pelo pm2, e o nginx faz o HTTPS na frente.

> Troque `clicker.seudominio.com` pelo seu domínio. Ele precisa ter um registro DNS **A** apontando para a VPS.

## 1. Código

Requer **Node.js 22.13+** (`node --version`).

```bash
git clone https://github.com/Catfallen/audio-watch-clicker.git ~/audio-watch-clicker
cd ~/audio-watch-clicker/server
npm ci --omit=dev
```

## 2. `.env`

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # gera o JWT_SECRET
nano .env
```

```ini
JWT_SECRET=cole-o-valor-gerado
PORT=3367
REGISTRO_ABERTO=true
TRUST_PROXY=1
```

```bash
chmod 600 .env
```

## 3. pm2

```bash
pm2 start server.js --name audio-watch-clicker \
  --node-args="--env-file=.env --disable-warning=ExperimentalWarning"
pm2 save
```

Confira: `pm2 logs audio-watch-clicker` deve mostrar `Servidor ouvindo na porta 3367`.

## 4. nginx

Crie `/etc/nginx/sites-available/audio-watch-clicker`:

```nginx
server {
    listen 80;
    server_name clicker.seudominio.com;

    location / {
        proxy_pass http://127.0.0.1:3367;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # SSE: entrega os eventos na hora e mantém a conexão aberta
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/audio-watch-clicker /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d clicker.seudominio.com
```

> A porta 3367 **não** precisa ser liberada no firewall: só o nginx acessa, de dentro da VPS.

## 5. Testar

1. Abra `https://clicker.seudominio.com`, crie sua conta e envie um **evento de teste**.
2. No PC do jogo, conecte o clicker (pede e-mail e senha só na primeira vez):

```powershell
$env:NOTIF_URL = 'https://clicker.seudominio.com'
.\.venv\Scripts\python.exe auto_clicker.py --calibrar
```

O PC deve aparecer em **"Clickers"** no painel em até 10 s.

## 6. Fechar o cadastro

Depois de criar as contas necessárias, troque `REGISTRO_ABERTO=true` por `false` no `.env` e reinicie:

```bash
pm2 restart audio-watch-clicker
```

## Manutenção

| Para quê | Comando |
|---|---|
| Logs | `pm2 logs audio-watch-clicker` |
| Reiniciar | `pm2 restart audio-watch-clicker` |
| Atualizar | `cd ~/audio-watch-clicker && git pull && cd server && npm ci --omit=dev && pm2 restart audio-watch-clicker` |
| Backup | `cd ~/audio-watch-clicker/server && node --disable-warning=ExperimentalWarning -e "new (require('node:sqlite').DatabaseSync)('dados.db').exec(\"VACUUM INTO 'backup-$(date +%F).db'\")"` |

O banco fica em `server/dados.db`. Faça backup com o comando acima, e não copiando o arquivo direto: com o servidor rodando, a cópia direta pode sair sem os dados recentes.

## Problemas comuns

| Sintoma | Solução |
|---|---|
| `502 Bad Gateway` | servidor parado: `pm2 logs audio-watch-clicker` |
| `Defina JWT_SECRET...` nos logs | `JWT_SECRET` ausente ou com menos de 32 caracteres no `.env` |
| `No such built-in module: node:sqlite` | atualize o Node para 22.13+ |
| Avisos atrasam ou o painel fica em "Reconectando..." | faltou `proxy_buffering off` ou `proxy_read_timeout 1h` no nginx |
| Login responde `429` para todo mundo | faltou `TRUST_PROXY=1` no `.env` |
