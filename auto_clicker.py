"""Auto clicker com parada automática por áudio.

Uso:
  python auto_clicker.py              # roda o clicker
  python auto_clicker.py --calibrar   # só mostra o nível do áudio ao vivo, sem clicar

Teclas:
  l    pausa / retoma o clicker
  esc  encerra o programa

Parada por áudio: o padrão normal sempre tem pausas de silêncio. Se nos últimos
JANELA_AUDIO segundos o som nunca ficar abaixo de LIMIAR_DB, o clicker pausa.
Ele só volta a clicar quando você apertar a tecla.

Notificações: defina NOTIF_URL (ex.: https://seu-servidor.com) e o programa pede
e-mail e senha na primeira vez. A sessão fica salva em ~/.audio-watch-clicker/,
então nas próximas vezes não pede de novo (nem precisa do NOTIF_URL).
  python auto_clicker.py --login    # entra com outra conta / refaz o login
  python auto_clicker.py --logout   # encerra a sessão salva
"""
import collections
import getpass
import json
import os
import queue
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
import pyaudiowpatch as pyaudio
from pynput import keyboard
from pynput.mouse import Button, Controller

INTERVALO = 0.5        # segundos entre cliques
TEMPO_INICIAL = 5      # segundos antes de começar (para dar Alt+Tab)
TECLA_PAUSAR = "l"     # pausa / retoma o clicker

JANELA_AUDIO = 3.0     # segundos sem nenhum silêncio para considerar anomalia
LIMIAR_DB = -60.0      # abaixo disso conta como silêncio (dBFS)
BLOCO = 2048           # amostras por leitura de áudio (~45 ms)

NOTIF_URL = os.environ.get("NOTIF_URL", "").rstrip("/")
CLIENTE = os.environ.get("CLICKER_NOME") or socket.gethostname()  # nome deste PC no painel
ARQUIVO_SESSAO = Path.home() / ".audio-watch-clicker" / "sessao.json"
HEARTBEAT = 10         # segundos entre sinais de "estou vivo" para o servidor

mouse = Controller()
clicando = threading.Event()
sair = threading.Event()


class ErroSessao(Exception):
    pass


class Sessao:
    """Login no servidor: guarda o refresh token em disco e renova o access token (JWT)."""

    def __init__(self, url):
        self.url = url
        self.access = None
        self.expira = 0.0
        self.refresh = None
        self.email = None
        self.trava = threading.Lock()
        try:
            salvo = json.loads(ARQUIVO_SESSAO.read_text(encoding="utf-8"))
            if salvo.get("url") == url:
                self.refresh, self.email = salvo.get("refreshToken"), salvo.get("email")
        except (OSError, ValueError):
            pass

    @staticmethod
    def url_salva():
        try:
            return json.loads(ARQUIVO_SESSAO.read_text(encoding="utf-8")).get("url", "")
        except (OSError, ValueError):
            return ""

    def _http(self, metodo, caminho, corpo=None, token=None):
        """Faz a requisição e devolve (status, json). Erros de rede sobem como exceção."""
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        dados = json.dumps(corpo).encode() if corpo is not None else None
        req = urllib.request.Request(self.url + caminho, data=dados, headers=headers, method=metodo)
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                texto = r.read().decode() or "{}"
                return r.status, json.loads(texto)
        except urllib.error.HTTPError as erro:
            try:
                return erro.code, json.loads(erro.read().decode() or "{}")
            except ValueError:
                return erro.code, {}

    def _aplicar(self, tokens):
        self.access = tokens["accessToken"]
        self.expira = time.monotonic() + tokens["expiraEm"] - 60  # renova 1 min antes
        self.refresh = tokens["refreshToken"]
        self.email = tokens["usuario"]["email"]
        ARQUIVO_SESSAO.parent.mkdir(parents=True, exist_ok=True)
        ARQUIVO_SESSAO.write_text(
            json.dumps({"url": self.url, "email": self.email, "refreshToken": self.refresh}),
            encoding="utf-8",
        )

    def login(self, email, senha):
        status, corpo = self._http("POST", "/api/auth/login",
                                   {"email": email, "senha": senha, "dispositivo": f"clicker: {CLIENTE}"})
        if status != 200:
            raise ErroSessao(corpo.get("erro", f"HTTP {status}"))
        self._aplicar(corpo)

    def renovar(self):
        if not self.refresh:
            raise ErroSessao("sem sessão salva")
        status, corpo = self._http("POST", "/api/auth/refresh", {"refreshToken": self.refresh})
        if status != 200:
            self.refresh = None
            ARQUIVO_SESSAO.unlink(missing_ok=True)
            raise ErroSessao(corpo.get("erro", f"HTTP {status}"))
        self._aplicar(corpo)

    def requisicao(self, metodo, caminho, corpo=None):
        """Requisição autenticada: renova o token quando vence ou quando recebe 401."""
        with self.trava:
            if not self.access or time.monotonic() > self.expira:
                self.renovar()
            status, resposta = self._http(metodo, caminho, corpo, self.access)
            if status == 401:
                self.renovar()
                status, resposta = self._http(metodo, caminho, corpo, self.access)
            return status, resposta

    def logout(self):
        if self.refresh:
            try:
                self._http("POST", "/api/auth/logout", {"refreshToken": self.refresh})
            except OSError:
                pass
        ARQUIVO_SESSAO.unlink(missing_ok=True)


def entrar(url, forcar=False):
    """Restaura a sessão salva ou pede e-mail e senha. Retorna a Sessao autenticada."""
    sessao = Sessao(url)
    if sessao.refresh and not forcar:
        try:
            sessao.renovar()
            print(f"Sessão restaurada: {sessao.email} em {url}")
            return sessao
        except ErroSessao as erro:
            print(f"Sessão salva não vale mais ({erro}). Faça login novamente.")
        except OSError as erro:
            raise SystemExit(f"Não foi possível conectar a {url}: {erro}")

    print(f"Login em {url}")
    for _ in range(3):
        email = input("E-mail: ").strip()
        senha = getpass.getpass("Senha: ")
        try:
            sessao.login(email, senha)
            print(f"Logado como {sessao.email}. A sessão fica salva para as próximas vezes.")
            return sessao
        except ErroSessao as erro:
            print(f"Falha no login: {erro}")
        except OSError as erro:
            raise SystemExit(f"Não foi possível conectar a {url}: {erro}")
    raise SystemExit("Não foi possível entrar. Encerrando.")


class Notificador:
    """Envia eventos ao servidor numa thread separada para não travar o clicker."""

    def __init__(self, sessao=None):
        self.sessao = sessao
        self.ativo = sessao is not None
        self.fila = queue.Queue()
        self.falhando = False
        if self.ativo:
            threading.Thread(target=self._enviar_fila, daemon=True).start()
            threading.Thread(target=self._heartbeat, daemon=True).start()
            print(f"Notificações ativas para {sessao.email} (este PC aparece como '{CLIENTE}').")
        else:
            print("Notificações desligadas (defina NOTIF_URL para usar o servidor).")

    def enviar(self, tipo, mensagem=""):
        if self.ativo:
            self.fila.put({"tipo": tipo, "mensagem": mensagem, "clicando": clicando.is_set(), "cliente": CLIENTE})

    def _post(self, evento):
        status, corpo = self.sessao.requisicao("POST", "/api/eventos", evento)
        if status != 201:
            raise RuntimeError(corpo.get("erro", f"HTTP {status}"))

    def _enviar_fila(self):
        while True:
            evento = self.fila.get()
            for tentativa in range(3):
                try:
                    self._post(evento)
                    if self.falhando:
                        print("Conexão com o servidor de notificações restabelecida.")
                    self.falhando = False
                    break
                except ErroSessao as erro:
                    if not self.falhando:
                        print(f"Sessão expirada ({erro}). Rode com --login para entrar de novo.")
                    self.falhando = True
                    break
                except Exception as erro:
                    if not self.falhando:
                        print(f"Falha ao notificar o servidor: {erro}")
                    self.falhando = True
                    time.sleep(2 * (tentativa + 1))

    def _heartbeat(self):
        while not sair.wait(HEARTBEAT):
            self.enviar("heartbeat")

    def esvaziar(self, timeout=5):
        """Espera os eventos pendentes saírem antes de encerrar o programa."""
        fim = time.monotonic() + timeout
        while self.ativo and not self.fila.empty() and time.monotonic() < fim:
            time.sleep(0.1)
        time.sleep(0.5 if self.ativo else 0)


class MonitorAudio:
    """Captura o áudio do sistema (loopback WASAPI) e mede o volume por bloco."""

    def __init__(self):
        self.niveis = collections.deque()  # (instante, dBFS)
        self.trava = threading.Lock()
        self.ultimo_bloco = time.monotonic()

    def _registrar(self, db):
        agora = time.monotonic()
        with self.trava:
            # O loopback não entrega dados quando nada está tocando: isso é silêncio
            if agora - self.ultimo_bloco > 0.2:
                self.niveis.append((agora, -100.0))
            self.ultimo_bloco = agora
            self.niveis.append((agora, db))
            while self.niveis and self.niveis[0][0] < agora - JANELA_AUDIO - 1:
                self.niveis.popleft()

    def capturar(self):
        pa = pyaudio.PyAudio()
        disp = pa.get_default_wasapi_loopback()
        canais = disp["maxInputChannels"]
        stream = pa.open(
            format=pyaudio.paFloat32,
            channels=canais,
            rate=int(disp["defaultSampleRate"]),
            input=True,
            input_device_index=disp["index"],
            frames_per_buffer=BLOCO,
        )
        print(f"Capturando áudio de: {disp['name']}")
        try:
            while not sair.is_set():
                dados = stream.read(BLOCO, exception_on_overflow=False)
                amostras = np.frombuffer(dados, dtype=np.float32)
                rms = np.sqrt(np.mean(amostras ** 2))
                self._registrar(20 * np.log10(rms + 1e-10))
        finally:
            stream.close()
            pa.terminate()

    def reiniciar(self):
        """Descarta o histórico para exigir uma janela completa nova."""
        with self.trava:
            self.niveis.clear()
            self.ultimo_bloco = time.monotonic()

    def status(self):
        """Retorna (nível atual, mínimo da janela, janela completa?)."""
        agora = time.monotonic()
        with self.trava:
            if agora - self.ultimo_bloco > 0.2:
                return -100.0, -100.0, True
            janela = [db for t, db in self.niveis if t >= agora - JANELA_AUDIO]
            if not janela:
                return -100.0, -100.0, False
            completa = self.niveis[0][0] <= agora - JANELA_AUDIO
            return janela[-1], min(janela), completa

    def anomalia(self):
        _, minimo, completa = self.status()
        return completa and minimo > LIMIAR_DB


def ao_pressionar(tecla, monitor, notif):
    if tecla == keyboard.Key.esc:
        sair.set()
        return False
    if getattr(tecla, "char", None) == TECLA_PAUSAR:
        if clicando.is_set():
            clicando.clear()
            print("Pausado pela tecla. Aperte 'l' para retomar.")
            notif.enviar("pausado", "Clicker pausado pela tecla")
        else:
            monitor.reiniciar()
            clicando.set()
            print("Clicker retomado.")
            notif.enviar("retomado", "Clicker retomado pela tecla")


def calibrar(monitor, notif):
    print(f"Modo calibração: limiar = {LIMIAR_DB} dB, janela = {JANELA_AUDIO}s. Ctrl+C para sair.")
    print("No padrão normal, 'mín' deve ficar ABAIXO do limiar; na anomalia, ACIMA.")
    print("Anomalias também são enviadas ao servidor, para testar as notificações.\n")
    notif.enviar("iniciado", "Modo calibração iniciado (sem cliques)")
    em_anomalia = False
    try:
        while True:
            atual, minimo, _ = monitor.status()
            anomalia = monitor.anomalia()
            if anomalia and not em_anomalia:
                notif.enviar("anomalia", f"[calibração] Som fora do padrão às {time.strftime('%H:%M:%S')}")
            em_anomalia = anomalia
            barra = "#" * int(max(0, atual + 100) / 2)
            alerta = "  <-- ANOMALIA" if anomalia else ""
            print(f"\ratual {atual:7.1f} dB | mín {JANELA_AUDIO:.0f}s {minimo:7.1f} dB | "
                  f"{barra:<50}{alerta:<15}", end="", flush=True)
            time.sleep(0.1)
    except KeyboardInterrupt:
        print()
    sair.set()
    notif.enviar("encerrado", "Modo calibração encerrado")
    notif.esvaziar()


def main():
    url = NOTIF_URL or Sessao.url_salva()

    if "--logout" in sys.argv:
        if url:
            Sessao(url).logout()
        print("Sessão encerrada.")
        return

    if "--login" in sys.argv and not url:
        raise SystemExit("Defina NOTIF_URL com o endereço do servidor para fazer login.")

    notif = Notificador(entrar(url, forcar="--login" in sys.argv) if url else None)
    monitor = MonitorAudio()
    threading.Thread(target=monitor.capturar, daemon=True).start()

    if "--calibrar" in sys.argv:
        calibrar(monitor, notif)
        return

    for restante in range(TEMPO_INICIAL, 0, -1):
        print(f"Começando em {restante}...")
        time.sleep(1)

    listener = keyboard.Listener(on_press=lambda t: ao_pressionar(t, monitor, notif))
    listener.start()

    monitor.reiniciar()
    clicando.set()
    print(f"Clicker ativo! '{TECLA_PAUSAR}' pausa/retoma, 'esc' encerra.")
    notif.enviar("iniciado", "Clicker iniciado")

    cliques = 0
    while not sair.is_set():
        if not clicando.is_set():
            sair.wait(0.1)
            continue
        if monitor.anomalia():
            clicando.clear()
            hora = time.strftime("%H:%M:%S")
            print(f"Anomalia no áudio detectada ({hora}). "
                  f"Clicker pausado. Aperte '{TECLA_PAUSAR}' para retomar.")
            notif.enviar("anomalia", f"Som fora do padrão às {hora}. Clicker pausado.")
            continue
        mouse.click(Button.left)
        cliques += 1
        sair.wait(INTERVALO)

    print(f"Encerrado. Total de cliques: {cliques}")
    notif.enviar("encerrado", f"Clicker encerrado ({cliques} cliques)")
    notif.esvaziar()


if __name__ == "__main__":
    main()
