# audio-watch-clicker

Auto clicker para jogos **tycoon do Roblox** que fica de olho no som do jogo, **pausa sozinho quando o som quebra o padrão** e manda um **aviso em tempo real para outro dispositivo** (celular, outro PC, navegador).

### O problema

Em um tycoon, boa parte do jogo é repetição: clicar, coletar, esperar a produção e clicar de novo. Um auto clicker resolve os cliques, mas cria outro problema: **alguém precisa ficar ouvindo o jogo** para perceber quando algo diferente acontece. Enquanto tudo vai bem, o som é sempre o mesmo ciclo. Quando acontece algo fora do comum, o som muda. Continuar clicando às cegas nessa hora desperdiça cliques, ou pior.

### A solução

Analisando uma gravação real de um tycoon, o som normal apareceu como um **ciclo que se repete**: rajadas curtas de som, sempre separadas por **pausas de silêncio**. Quando o padrão quebra, entra um **som contínuo e tonal**, que dura vários segundos **sem nenhuma pausa**.

```
Padrão normal     ▌▌▐  ▌▐▌   ▌▌▐  ▌▐▌   ▌▌▐  ▌▐▌      ← sempre há silêncio entre as rajadas
Quebra de padrão  ███████████████████████████████      ← som contínuo, nenhum silêncio
```

O `audio-watch-clicker` vigia exatamente isso. Enquanto ainda existe silêncio a cada poucos segundos, ele continua clicando. Se o som fica contínuo por 3 segundos, ele:

1. **Pausa o clicker** e só volta quando você mandar, pela tecla `l`.
2. **Avisa você em todos os seus dispositivos**: banner, alarme e notificação no celular ou no navegador.

Assim **você não precisa ouvir nada**. O jogo pode rodar no mudo, você pode estar em outro cômodo, e o aviso chega no celular. Se o PC travar ou a internet cair, o servidor também avisa que o clicker ficou offline.

Um único servidor (VPS) atende **várias pessoas**. Cada uma tem sua conta (login com JWT), e os avisos de um PC chegam **só nos dispositivos do dono**. Uma pessoa pode ter vários PCs rodando o clicker e acompanhar todos no mesmo painel.

> A regra foi calibrada para esse tipo de áudio, com rajadas e pausas no normal e som contínuo na quebra. Para outros jogos ou sons, veja [Funciona para qualquer áudio?](#funciona-para-qualquer-áudio).

```
 PCs dos jogadores                          VPS (uma só)                    Dispositivos de cada usuário
┌───────────────────────────┐            ┌──────────────────────┐         ┌───────────────────────────┐
│ auto_clicker.py (Ana, PC1)│──┐         │ server/ (Express)    │    ┌───▶│ Ana: navegador, celular   │
│ auto_clicker.py (Ana, PC2)│──┼─ HTTPS ▶│  • login JWT         │─SSE┤    └───────────────────────────┘
│ auto_clicker.py (Bia)     │──┘  JWT    │  • eventos por conta │    │    ┌───────────────────────────┐
│  • clica, escuta o áudio  │            │  • SQLite            │    └───▶│ Bia: navegador, celular   │
│  • pausa na anomalia      │            └──────────────────────┘         └───────────────────────────┘
└───────────────────────────┘
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
- **Node.js 22.13+** para o servidor (usa o SQLite embutido no Node, `node:sqlite`; testado no 22.16).

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
cp .env.example .env   # e defina o JWT_SECRET
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

Crie sua conta pela página do servidor (`https://seu-dominio`, opção "Cadastre-se"). Na **primeira vez**, informe o endereço do servidor:

```powershell
$env:NOTIF_URL = 'https://seu-dominio'
.\.venv\Scripts\python.exe auto_clicker.py
```

O programa pede **e-mail e senha** uma única vez. A sessão fica salva em `%USERPROFILE%\.audio-watch-clicker\sessao.json`, com o endereço do servidor e um refresh token. A senha **não** é salva. Nas próximas vezes basta rodar `auto_clicker.py`, sem `NOTIF_URL` e sem senha.

```powershell
.\.venv\Scripts\python.exe auto_clicker.py --login    # entrar com outra conta / refazer o login
.\.venv\Scripts\python.exe auto_clicker.py --logout   # encerrar a sessão (revoga no servidor e apaga o arquivo)
```

- No painel, cada PC aparece com o **nome do computador**. Para usar outro nome, defina `CLICKER_NOME`.
- Sem servidor configurado, o clicker funciona normalmente, só não envia notificações.
- Os envios acontecem numa thread separada: se a internet cair, o clicker continua clicando.
- O access token (JWT) vale 15 minutos e é renovado sozinho. A sessão salva vale 30 dias e é renovada a cada uso. Se ficar mais de 30 dias sem usar, o programa pede a senha de novo.

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
| `NOTIF_URL` | endereço do servidor, ex.: `https://seu-dominio` (só na primeira vez; depois fica salvo) |
| `CLICKER_NOME` | nome deste PC no painel (padrão: nome do computador) |

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

Pasta `server/`. Node com Express e `jsonwebtoken`. O banco é o SQLite embutido no Node, então não há dependência nativa para compilar.

- **Contas:** cadastro e login com e-mail e senha. A senha é guardada com hash `scrypt` e sal.
- **Sessão:** o login devolve um **access token JWT** (15 min) e um **refresh token** (30 dias).
  - O refresh token é **rotativo**: cada uso gera um novo e invalida o anterior.
  - No banco fica só o hash dele.
  - O logout revoga o refresh token.
- **Isolamento:** o usuário vem do JWT. Um clicker só publica para a conta dele, e cada dispositivo só recebe os eventos da própria conta.
- **Vários PCs por conta:** cada clicker se identifica pelo nome (`cliente`). O painel mostra o estado de cada um (clicando, pausado ou offline).
- **Tempo real:** os dispositivos recebem eventos por **SSE** (Server-Sent Events). A autenticação é pelo header `Authorization`, então o token não aparece na URL nem nos logs do nginx.
- **Offline:** se um clicker passar **30 s sem enviar sinal de vida**, o servidor publica `offline` para aquele PC.
- **Histórico:** os últimos 200 eventos de cada usuário ficam no banco. Quem reconecta recebe o que perdeu, marcado como `replay` para não tocar o alarme de novo.
- **Proteção contra força bruta:** login e cadastro aceitam 10 tentativas a cada 15 minutos por IP.
- **Keepalive:** a cada 15 s o servidor envia um comentário para proxies não derrubarem a conexão SSE.

### Página web

Em `/` fica o painel web:
- tela de login e cadastro;
- lista de clickers da conta, com o estado de cada um;
- lista de eventos;
- banner vermelho, alarme sonoro, vibração (no celular) e notificação nativa.

O access token fica só em memória. O refresh token fica no `localStorage`, para manter o login entre visitas. O token é renovado sozinho quando vence.

Na página, **"Permitir notificações"** pede permissão de notificação e libera o áudio do navegador. **"Enviar evento de teste"** dispara um alerta de teste.

> Notificações nativas do navegador só funcionam em **HTTPS** (ou `localhost`).

### Rodando localmente

```bash
cd server
cp .env.example .env   # defina o JWT_SECRET
npm run dev            # usa o .env e reinicia ao salvar
# abra http://localhost:3000 e crie uma conta
```

### Variáveis de ambiente (`server/.env`)

| Variável | Obrigatória | Descrição |
|---|---|---|
| `JWT_SECRET` | sim | segredo para assinar os JWT, com pelo menos 32 caracteres |
| `PORT` | não | porta HTTP (padrão `3000`) |
| `REGISTRO_ABERTO` | não | `false` desativa novos cadastros (padrão `true`) |
| `TRUST_PROXY` | não | `1` atrás do nginx, para o limite de tentativas usar o IP real |
| `DB_PATH` | não | caminho do banco SQLite (padrão `server/dados.db`) |

> Se não quiser que estranhos criem contas no seu servidor, crie as contas necessárias e depois coloque `REGISTRO_ABERTO=false`.

---

## Deploy na VPS

### 1. Código e dependências

Requer **Node.js 22.13+**.

```bash
git clone https://github.com/Catfallen/audio-watch-clicker.git /opt/audio-watch-clicker
cd /opt/audio-watch-clicker/server
npm install --omit=dev
cp .env.example .env
# gere o segredo dos JWT:
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
# e coloque no .env: JWT_SECRET=...  (e TRUST_PROXY=1 se usar nginx)
```

### 2. Manter rodando (systemd)

`/etc/systemd/system/clicker-notif.service`:

```ini
[Unit]
Description=Servidor de notificações do audio-watch-clicker
After=network.target

[Service]
WorkingDirectory=/opt/audio-watch-clicker/server
ExecStart=/usr/bin/node --env-file=.env --disable-warning=ExperimentalWarning server.js
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo chown -R www-data /opt/audio-watch-clicker/server   # o banco é criado nessa pasta
sudo systemctl daemon-reload
sudo systemctl enable --now clicker-notif
journalctl -u clicker-notif -f   # logs
```

Com pm2 também funciona: `pm2 start npm --name clicker-notif -- start`.

**Backup:** os dados ficam em `dados.db` (contas, sessões e histórico). Para fazer backup, copie esse arquivo com o serviço parado.

### 3. HTTPS com nginx

HTTPS é **obrigatório** na prática. Sem ele, senhas e tokens trafegam abertos pela rede e o navegador bloqueia as notificações.

```nginx
server {
    server_name seu-dominio;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

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

Rotas fora de `/api/auth` exigem `Authorization: Bearer <accessToken>`. Erros respondem `{ "erro": "mensagem" }`.

### Autenticação

| Rota | Corpo | Resposta |
|---|---|---|
| `POST /api/auth/registrar` | `{ email, senha, dispositivo? }` | `201` tokens · `400` dados inválidos · `409` e-mail já cadastrado · `403` registro fechado |
| `POST /api/auth/login` | `{ email, senha, dispositivo? }` | `200` tokens · `401` e-mail ou senha incorretos |
| `POST /api/auth/refresh` | `{ refreshToken }` | `200` tokens novos (o refresh antigo deixa de valer) · `401` sessão expirada |
| `POST /api/auth/logout` | `{ refreshToken }` | `204` |
| `GET /api/me` | — | `{ id, email, criadoEm }` |

Login e cadastro respondem `429` depois de 10 tentativas em 15 minutos pelo mesmo IP.

Resposta com tokens:

```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIs...",
  "refreshToken": "kq3V0n...",
  "expiraEm": 900,
  "usuario": { "id": 1, "email": "ana@exemplo.com" }
}
```

`dispositivo` é só um rótulo da sessão, por exemplo `"web: Chrome"`, `"clicker: PC-SALA"` ou `"mobile: Android"`.

### `POST /api/eventos`

Enviado pelo clicker.

```json
{ "tipo": "anomalia", "mensagem": "Som fora do padrão às 14:03:22. Clicker pausado.", "clicando": false, "cliente": "PC-SALA" }
```

| Resposta | Quando |
|---|---|
| `201` | evento publicado para os dispositivos do usuário (retorna o evento com `id` e `data`) |
| `400` | tipo inválido (o cliente não pode enviar `online` nem `offline`) |
| `401` | token ausente, inválido ou expirado |

### `GET /api/eventos/stream`

Stream SSE com os eventos **da conta do token**. Cada mensagem tem `event: <tipo>` e `data: <json>`:

```
id: 7
event: anomalia
data: {"id":7,"tipo":"anomalia","mensagem":"...","cliente":"PC-SALA","clicando":false,"data":"2026-10-06T14:03:22.000Z"}
```

- Na conexão, recebe os eventos recentes (ou o que perdeu, se enviar `Last-Event-ID`), marcados com `"replay": true`. Em seguida recebe um evento `status`, com o estado de cada clicker: `{ "clickers": [{ "cliente", "online", "clicando", "ultimoContato" }] }`.
- O `EventSource` nativo do navegador não envia headers. Por isso a página web lê o stream com `fetch`. No app mobile, use uma biblioteca SSE que aceite headers (ex.: `react-native-sse`).
- O access token só é verificado na conexão. Ao reconectar depois de 15 min, renove o token antes.

### `GET /api/status`

```json
{
  "clickers": [{ "cliente": "PC-SALA", "online": true, "clicando": true, "ultimoContato": 1791271974741 }],
  "dispositivos": 2,
  "historico": []
}
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
| `online` | servidor (clicker voltou a dar sinal de vida) | não |
| `offline` | servidor (30 s sem sinal de vida daquele PC) | **sim** |
| `teste` | botão de teste da página (não conta como clicker) | **sim** |

---

## Limitações

- **Só no Windows**, por causa da captura de loopback via WASAPI.
- **A regra é específica para áudio com pausas.** Veja [Funciona para qualquer áudio?](#funciona-para-qualquer-áudio).
- **Captura todo o som do PC, não só o do jogo.** Outros sons tocando junto causam falso alarme.
- **Captura com o PC no mudo** depende do driver. Teste com `--calibrar`.
- **O `l` é digitado no jogo** ao pausar ou retomar.
- **Jogos rodando como administrador** podem ignorar cliques e teclas do script. Nesse caso, rode o script como administrador também.
- **Sem push nativo no celular (ainda):** o SSE só recebe com o navegador ou o app abertos. Com o celular bloqueado ou o app em segundo plano, o aviso só chega quando ele voltar. O caminho para isso é Web Push (navegador) ou FCM/APNs (app).
- **Estado online/offline em memória:** ao reiniciar o servidor, os clickers aparecem offline até o próximo sinal de vida (até 10 s). Contas e histórico ficam no banco.
- **Sem recuperação de senha nem verificação de e-mail.** Para trocar uma senha esquecida, é preciso editar o banco.
- **Refresh token em disco:** o `sessao.json` do PC dá acesso à conta por até 30 dias. Use `--logout` em PCs compartilhados.
- **Uma única instância do servidor:** as conexões SSE ficam na memória do processo. Para rodar várias instâncias seria preciso um barramento (ex.: Redis pub/sub).

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
| `Falha ao notificar o servidor` | servidor fora do ar, URL errada ou HTTPS inválido | abra a URL no navegador; confira com `--login` |
| `Sessão expirada. Rode com --login` | refresh token vencido (30 dias), revogado ou banco do servidor recriado | `auto_clicker.py --login` |
| `muitas tentativas, tente mais tarde` (429) | 10 tentativas de login/cadastro em 15 min | espere o tempo indicado; atrás do nginx, configure `TRUST_PROXY=1` |
| Servidor encerra com `Defina JWT_SECRET...` | `.env` sem `JWT_SECRET` ou com menos de 32 caracteres | gere um com o comando do [Deploy](#1-código-e-dependências) |
| `No such built-in module: node:sqlite` | Node antigo | atualize para Node 22.13+ |
| Todos deslogados depois de trocar o `JWT_SECRET` | access tokens antigos ficam inválidos | normal: eles renovam pelo refresh token na próxima requisição |
| Página fica em "Reconectando..." atrás do nginx | buffer do proxy ligado | `proxy_buffering off;` (veja [Deploy](#3-https-com-nginx)) |
| Notificação nativa não aparece | sem HTTPS ou sem permissão | use HTTPS e clique em "Permitir notificações" |

---

## Estrutura do projeto

```
.
├── auto_clicker.py        # clicker + detector de áudio + login + envio de eventos
├── analisar_audio.py      # análise de uma gravação (tabela + gráficos)
├── requirements.txt
├── audio.mp3              # gravação de referência (normal + anomalia no final)
└── server/
    ├── server.js          # rotas: auth, eventos, SSE por usuário
    ├── auth.js            # senha (scrypt), JWT, refresh token rotativo, limite de tentativas
    ├── db.js              # SQLite (usuários, sessões, eventos)
    ├── package.json
    ├── .env.example
    └── public/
        └── index.html     # painel web: login, clickers, eventos, alertas
```
