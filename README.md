# audio-watch-clicker

Auto clicker que monitora o áudio do jogo, **pausa sozinho quando o som sai do padrão** e envia uma **notificação em tempo real para outro dispositivo** (celular, outro PC, navegador). A ideia é você não precisar ouvir nada: o PC pode ficar no mudo e o aviso chega por outro lugar.

```
 PC do jogo                                   VPS                         Seus dispositivos
┌──────────────────────────┐   HTTP POST   ┌──────────────────┐   SSE    ┌──────────────────┐
│ auto_clicker.py          │ ────────────▶ │ server/server.js │ ───────▶ │ navegador / app  │
│  • clica a cada 0,5 s    │   eventos +   │  (Node + Express)│  tempo   │  banner, alarme, │
│  • escuta o áudio        │   heartbeat   │                  │   real   │  notificação     │
│  • pausa na anomalia     │               │                  │          │                  │
└──────────────────────────┘               └──────────────────┘          └──────────────────┘
```

---

## Sumário

- [Como funciona](#como-funciona)
- [Funciona para qualquer áudio?](#funciona-para-qualquer-áudio)
- [Requisitos](#requisitos)
- [Instalação](#instalação)
- [Uso do clicker](#uso-do-clicker)
- [Configuração](#configuração)
- [Analisando um áudio novo](#analisando-um-áudio-novo)
- [Servidor de notificações](#servidor-de-notificações)
- [Deploy na VPS](#deploy-na-vps)
- [API](#api)
- [Limitações](#limitações)
- [Solução de problemas](#solução-de-problemas)
- [Estrutura do projeto](#estrutura-do-projeto)

---

## Como funciona

### Clicker

1. Conta 5 segundos (tempo para dar Alt+Tab até o jogo).
2. Clica com o botão esquerdo a cada 0,5 s, na posição atual do mouse.
3. `l` pausa ou retoma, e `esc` encerra.
4. Quando o áudio sai do padrão, o clicker **pausa e não recomeça sozinho**. Ele só volta a clicar quando você aperta `l`.

### Detecção de anomalia

O script não usa um modelo treinado. Ele aplica uma regra simples, tirada da análise de uma gravação real do jogo:

> **No padrão normal sempre existe silêncio a cada poucos segundos. Na anomalia, o som é contínuo.**

Passo a passo:

1. **Captura**: lê o áudio que sai pelo alto-falante, usando a captura de loopback do Windows (WASAPI), em blocos de 2048 amostras (~45 ms).
2. **Volume**: calcula o volume médio de cada bloco (RMS) em dBFS. 0 dB é o máximo e silêncio total fica em -100 dB ou menos.
3. **Janela**: guarda os volumes dos últimos **3 segundos**.
4. **Decisão**: olha o **menor** volume da janela.
   - Algum momento abaixo de **-60 dB**: houve uma pausa, então o padrão é **normal**.
   - Nenhum momento abaixo de -60 dB: o som foi contínuo, então é **anomalia**. O clicker pausa e notifica.

Resultado na gravação de referência (`audio.mp3`, 2 minutos):

| Trecho | Volume mínimo numa janela de 3 s |
|---|---|
| Padrão normal (0:00 a 1:45) | sempre abaixo de **-79 dB** |
| Som anormal (1:47 em diante) | entre **-22 e -47 dB** |

Na simulação com essa gravação não houve **nenhum falso alarme**, e a anomalia foi detectada aos **109,7 s**, uns 2 a 3 segundos depois que o som contínuo começa.

Também foram testadas outras características: volume médio, tonalidade (*spectral flatness*), timbre (MFCC), ritmo (BPM) e a semelhança entre um ciclo e o anterior. Só o critério de existir silêncio separou os dois trechos **sem nenhuma sobreposição**.

---

## Funciona para qualquer áudio?

**Não.** A regra funciona quando o áudio tem estas duas propriedades:

| Propriedade | No áudio de referência |
|---|---|
| O padrão normal tem **pausas de silêncio** com intervalo menor que a janela (3 s) | ✅ rajadas de som separadas por silêncio |
| A anomalia é um **som contínuo**, sem pausas, por pelo menos 3 s | ✅ som tonal contínuo de ~10 s |

Ela **não** funciona nestes casos:

- **Normal contínuo**: o jogo tem música de fundo, ambiente ou trilha constante. Nunca há silêncio, então o clicker pausa logo no início.
- **Anomalia com pausas**: o som diferente é curto (um bipe, um alerta rápido) ou tem silêncios no meio. Ele nunca é detectado.
- **Silêncios longos no normal**: o ciclo normal tem pausas mais espaçadas que 3 s. Aí funciona com uma janela maior, mas a detecção fica mais lenta.
- **Diferença só de timbre ou frequência**: o som anormal tem o mesmo ritmo de som e silêncio, só com outra "cor". Precisa de outra característica, como espectrograma ou MFCC.
- **Outros sons no PC**: música, Discord ou vídeo tapam as pausas e causam falso alarme.

### Como adaptar para outro jogo ou áudio

1. Grave um trecho com o padrão normal seguido da anomalia (de preferência com a anomalia no final).
2. Rode `analisar_audio.py` nessa gravação (veja [Analisando um áudio novo](#analisando-um-áudio-novo)).
3. Interprete o resultado:
   - Se `min_db` **separa** (aparece `SIM` na tabela), ajuste `LIMIAR_DB` para o meio do intervalo entre as duas faixas e `JANELA_AUDIO` para pouco mais que o maior silêncio do ciclo normal.
   - Se `min_db` **não separa**, mas outra característica separa (por exemplo `flatness` ou `semelhanca`), é preciso mudar a regra em `MonitorAudio.anomalia()` para usar essa característica.
   - Se **nada separa**, o caminho é um modelo: comparar o espectrograma com o ciclo normal (autoencoder ou distância de embeddings, como YAMNet ou PANNs) ou treinar um classificador com exemplos rotulados.

---

## Requisitos

- **Windows**, por causa da captura de loopback via WASAPI.
- **Python 3.12 64 bits**. O `requirements.txt` fixa versões testadas nele. Python 32 bits **não funciona** com o librosa.
- **Node.js 20+** para o servidor (testado no 22).

---

## Instalação

### Clicker (PC do jogo)

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

O `requirements.txt` é um `pip freeze` completo, com todas as dependências fixadas. Os pacotes usados diretamente são:

| Pacote | Para quê |
|---|---|
| `pynput` | clique do mouse e teclas de atalho |
| `pyaudiowpatch` | captura do áudio do sistema (loopback WASAPI) |
| `numpy` | cálculo do volume |
| `librosa`, `matplotlib` | só para o `analisar_audio.py` |

### Servidor

```bash
cd server
npm install
cp .env.example .env   # e troque o TOKEN
```

---

## Uso do clicker

> Use sempre o Python do `.venv`. Se você digitar só `python`, pode abrir outra instalação, sem as bibliotecas.

```powershell
# Clicker normal
.\.venv\Scripts\python.exe auto_clicker.py

# Calibração: não clica, só mostra o nível do áudio ao vivo
.\.venv\Scripts\python.exe auto_clicker.py --calibrar
```

| Tecla | Ação |
|---|---|
| `l` | pausa ou retoma o clicker (retomar é imediato) |
| `esc` | encerra o programa |

> O `l` também é digitado na janela que estiver em foco. Evite apertá-lo sobre campos de texto do jogo.

### Com notificações

Defina o endereço e o token do servidor antes de rodar:

```powershell
$env:NOTIF_URL = 'https://seu-dominio'
$env:NOTIF_TOKEN = 'seu-token'
.\.venv\Scripts\python.exe auto_clicker.py
```

Sem essas variáveis o clicker funciona normalmente, só não envia notificações. Os envios acontecem numa thread separada, então se a internet cair o clicker continua clicando.

### Calibração

O modo `--calibrar` mostra uma linha assim:

```
atual  -34.2 dB | mín 3s  -88.5 dB | ##############################
```

- Com o padrão normal tocando, **`mín 3s` deve ficar abaixo de `LIMIAR_DB`** (-60).
- Com o som anormal, deve aparecer **`<-- ANOMALIA`**, e o evento também é enviado ao servidor.

Se não bater, ajuste `LIMIAR_DB` no topo do `auto_clicker.py`.

---

## Configuração

Constantes no topo do `auto_clicker.py`:

| Constante | Padrão | Descrição |
|---|---|---|
| `INTERVALO` | `0.5` | segundos entre cliques |
| `TEMPO_INICIAL` | `5` | contagem antes de começar |
| `TECLA_PAUSAR` | `"l"` | tecla de pausar/retomar |
| `JANELA_AUDIO` | `3.0` | segundos sem silêncio para considerar anomalia |
| `LIMIAR_DB` | `-60.0` | abaixo disso conta como silêncio (dBFS) |
| `BLOCO` | `2048` | amostras por leitura de áudio |
| `HEARTBEAT` | `10` | segundos entre os sinais de vida enviados ao servidor |

Variáveis de ambiente:

| Variável | Descrição |
|---|---|
| `NOTIF_URL` | endereço do servidor, ex.: `https://seu-dominio` |
| `NOTIF_TOKEN` | o mesmo `TOKEN` configurado no servidor |

> **Volume do Windows:** a regra mede se existe silêncio, não se o som é alto. Aumentar o volume não atrapalha: as pausas continuam silenciosas e a anomalia fica mais alta. Se a captura continua funcionando com o PC **no mudo** depende do driver de áudio. Confirme com `--calibrar` antes de confiar.

---

## Analisando um áudio novo

```powershell
.\.venv\Scripts\python.exe analisar_audio.py                    # audio.mp3, últimos 15 s anormais
.\.venv\Scripts\python.exe analisar_audio.py gravacao.mp3 20    # outro arquivo, últimos 20 s anormais
```

O script:

1. Estima o **período do ciclo** normal (autocorrelação do volume).
2. Calcula quatro características numa janela deslizante do tamanho de um ciclo:

| Característica | O que mede |
|---|---|
| `min_db` | volume mínimo na janela (existe pausa?) |
| `silencio` | fração da janela em silêncio |
| `flatness` | ruidosidade; valores baixos indicam som tonal, com notas |
| `semelhanca` | correlação do espectrograma do último ciclo com o anterior |

3. Imprime uma tabela com a faixa de valores no normal e no anormal, o *d de Cohen* (tamanho da diferença) e **se as faixas se sobrepõem**. Também mostra em que instante cada característica detectaria a anomalia.
4. Salva `analise_audio.png` com a forma de onda, o espectrograma, um zoom na transição e o gráfico de cada característica, com a faixa normal destacada.

Uma característica serve como gatilho quando aparece **`SIM`** na coluna "separa?", ou seja, quando os valores do normal e do anormal não se misturam.

---

## Servidor de notificações

Pasta `server/`. Node com Express, uma única dependência.

- O clicker envia eventos com **`POST /api/eventos`**.
- Os dispositivos recebem em tempo real com **SSE** (Server-Sent Events) em `/api/eventos/stream`.
- A **página de teste** em `/` serve para acompanhar pelo navegador: mostra o status do clicker, a lista de eventos, um banner vermelho, alarme sonoro, vibração (no celular) e notificação nativa.
- Se o clicker passar **30 s sem enviar sinal de vida**, o servidor publica `offline` (PC travou, caiu a internet ou o programa fechou).
- Os últimos 50 eventos ficam guardados. Quem reconecta recebe o que perdeu, marcado como `replay` para não tocar o alarme de novo.
- A cada 15 s o servidor envia um *keepalive* para proxies não derrubarem a conexão SSE.

### Rodando localmente

```bash
cd server
npm run dev          # usa o .env e reinicia ao salvar
# abra http://localhost:3000, cole o token e clique em Conectar
```

Na página, **"Permitir notificações"** pede permissão de notificação e libera o áudio do navegador. **"Enviar evento de teste"** dispara um alerta de teste.

> Notificações nativas do navegador só funcionam em **HTTPS** (ou `localhost`).

---

## Deploy na VPS

### 1. Código e dependências

```bash
git clone <repo> && cd <repo>/server
npm install --omit=dev
cp .env.example .env
# gere um token forte:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# e coloque no .env: TOKEN=...
```

### 2. Manter rodando (systemd)

`/etc/systemd/system/clicker-notif.service`:

```ini
[Unit]
Description=Servidor de notificações do auto clicker
After=network.target

[Service]
WorkingDirectory=/opt/audio-watch-clicker/server
ExecStart=/usr/bin/node --env-file=.env server.js
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now clicker-notif
journalctl -u clicker-notif -f   # logs
```

Com pm2 também funciona: `pm2 start "node --env-file=.env server.js" --name clicker-notif`.

### 3. HTTPS com nginx

HTTPS é **obrigatório** na prática, porque o navegador bloqueia notificações sem ele e o token iria aberto pela rede.

```nginx
server {
    server_name seu-dominio;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;

        # SSE: sem buffer e com timeout longo
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }
}
```

```bash
sudo certbot --nginx -d seu-dominio
```

---

## API

Todas as rotas exigem o token, de uma destas formas:

- Header `Authorization: Bearer <TOKEN>`.
- Query `?token=<TOKEN>`. Necessário no SSE, porque o `EventSource` do navegador não envia headers.

### `POST /api/eventos`

Enviado pelo clicker.

```json
{ "tipo": "anomalia", "mensagem": "Som fora do padrão às 14:03:22. Clicker pausado.", "clicando": false }
```

| Resposta | Quando |
|---|---|
| `201` | evento publicado (retorna o evento com `id` e `data`) |
| `400` | tipo inválido |
| `401` | token ausente ou errado |

### `GET /api/eventos/stream`

Stream SSE para os dispositivos. Cada mensagem tem `event: <tipo>` e `data: <json>`:

```
id: 7
event: anomalia
data: {"id":7,"tipo":"anomalia","mensagem":"...","data":"2026-10-06T14:03:22.000Z","clicando":false}
```

- Ao conectar, recebe o histórico perdido (com `"replay": true`) e um evento `status` com o estado atual.
- Para retomar de onde parou, use o header `Last-Event-ID` (o `EventSource` envia automaticamente ao reconectar) ou `?desde=<id>`.

### `GET /api/status`

```json
{ "online": true, "clicando": true, "ultimoContato": 1791271974741, "dispositivos": 1, "historico": [] }
```

### Tipos de evento

| Tipo | Origem | Gera alerta na página |
|---|---|---|
| `iniciado` | clicker começou (ou entrou no modo calibração) | não |
| `anomalia` | som fora do padrão, clicker pausado | **sim** |
| `pausado` | pausado pela tecla `l` | não |
| `retomado` | retomado pela tecla `l` | não |
| `encerrado` | programa fechado com `esc` | não |
| `heartbeat` | sinal de vida a cada 10 s (não vai para o histórico) | não |
| `online` | servidor voltou a receber sinal de vida | não |
| `offline` | 30 s sem sinal de vida | **sim** |
| `teste` | botão de teste da página | **sim** |

---

## Limitações

- **Só no Windows**, por causa da captura de loopback via WASAPI.
- **A regra é específica para áudio com pausas.** Veja [Funciona para qualquer áudio?](#funciona-para-qualquer-áudio).
- **Captura todo o som do PC, não só o do jogo.** Outros sons tocando junto causam falso alarme.
- **Captura com o PC no mudo** depende do driver. Teste com `--calibrar`.
- **O `l` é digitado no jogo** ao pausar ou retomar.
- **Jogos rodando como administrador** podem ignorar cliques e teclas do script. Nesse caso, rode o script como administrador também.
- **O servidor guarda tudo em memória**: reiniciar apaga o histórico, o que não afeta o funcionamento.
- **Um token só**: qualquer pessoa com o token pode enviar e receber eventos.

---

## Solução de problemas

| Sintoma | Causa provável | Solução |
|---|---|---|
| `ValueError: array is too big` no librosa | Python 32 bits | recrie o `.venv` com Python 64 bits (`py -3.12 -m venv .venv`) |
| `pip` tenta compilar e falha com `Unknown compiler` | versão do Python sem wheels prontos | use Python 3.12 64 bits ou `pip install --only-binary :all: ...` |
| `ModuleNotFoundError` | rodou com `python` em vez do `.venv` | use `.\.venv\Scripts\python.exe` |
| Calibração mostra sempre `-200 dB` | nada tocando, ou dispositivo de saída errado | toque algum som e confirme o dispositivo em "Capturando áudio de:" |
| Pausa sozinho logo no início | outro som tocando, ou jogo com som contínuo | feche outros sons ou reanalise com `analisar_audio.py` |
| Nunca detecta a anomalia | captura baixa demais, ou anomalia com pausas | rode `--calibrar` e ajuste `LIMIAR_DB` |
| `Falha ao notificar o servidor` | URL, token ou HTTPS errados | teste com `curl` no `/api/status` |
| Página fica em "Reconectando..." atrás do nginx | buffer do proxy ligado | `proxy_buffering off;` (veja [Deploy](#3-https-com-nginx)) |
| Notificação nativa não aparece | sem HTTPS ou sem permissão | use HTTPS e clique em "Permitir notificações" |

---

## Estrutura do projeto

```
.
├── auto_clicker.py        # clicker + detector de áudio + envio de eventos
├── analisar_audio.py      # análise de uma gravação (tabela + gráficos)
├── requirements.txt
├── audio.mp3              # gravação de referência (normal + anomalia no final)
└── server/
    ├── server.js          # API + SSE
    ├── package.json
    ├── .env.example
    └── public/
        └── index.html     # página de monitoramento e teste
```
