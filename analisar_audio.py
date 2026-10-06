"""Analisa um áudio para encontrar o que diferencia o trecho "fora do padrão".

Uso: python analisar_audio.py [arquivo] [segundos_anormais_no_final]

O áudio normal é um ciclo que se repete. Por isso, além de features por quadro,
o script mede features numa janela deslizante do tamanho de um ciclo:
  - min_db:      volume mínimo na janela (o ciclo normal tem pausas silenciosas)
  - silencio:    fração da janela em silêncio
  - flatness:    "ruidosidade" média (baixo = som tonal, com notas/harmônicos)
  - semelhanca:  correlação do mel-espectrograma do último ciclo com o anterior
Gera analise_audio.png e imprime qual feature separa melhor normal x anormal.
"""
import sys

import librosa
import librosa.display
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

ARQUIVO = sys.argv[1] if len(sys.argv) > 1 else "audio.mp3"
SEG_ANORMAL = float(sys.argv[2]) if len(sys.argv) > 2 else 15.0
SR = 22050
HOP = 512
SAIDA = "analise_audio.png"


def estimar_periodo(rms_db, fps, min_s=0.5, max_s=10.0):
    """Período do ciclo (s) pelo pico da autocorrelação do envelope de volume."""
    x = rms_db - rms_db.mean()
    ac = np.correlate(x, x, mode="full")[len(x) - 1:]
    lo, hi = int(min_s * fps), int(max_s * fps)
    lag = lo + np.argmax(ac[lo:hi])
    return lag / fps


def rolar(v, n, func):
    """Aplica func numa janela deslizante de n quadros terminando em cada quadro."""
    out = np.full(len(v), np.nan)
    for i in range(n, len(v) + 1):
        out[i - 1] = func(v[i - n:i])
    return out


def semelhanca_ciclos(mel_db, n):
    """Correlação entre o último ciclo (n quadros) e o ciclo anterior."""
    out = np.full(mel_db.shape[1], np.nan)
    for i in range(2 * n, mel_db.shape[1] + 1):
        a = mel_db[:, i - n:i].ravel()
        b = mel_db[:, i - 2 * n:i - n].ravel()
        out[i - 1] = np.corrcoef(a, b)[0, 1]
    return out


def cohen_d(a, b):
    a, b = a[~np.isnan(a)], b[~np.isnan(b)]
    desvio = np.sqrt((a.var() + b.var()) / 2) or 1e-12
    return (b.mean() - a.mean()) / desvio


def main():
    y, sr = librosa.load(ARQUIVO, sr=SR, mono=True)
    duracao = len(y) / sr
    inicio_anormal = duracao - SEG_ANORMAL
    fps = sr / HOP
    print(f"Arquivo: {ARQUIVO} | duração: {duracao:.1f}s")
    print(f"Trecho anormal assumido: {inicio_anormal:.1f}s -> {duracao:.1f}s")

    rms = librosa.feature.rms(y=y, hop_length=HOP)[0]
    rms_db = librosa.amplitude_to_db(rms, ref=np.max)
    flat = librosa.feature.spectral_flatness(y=y, hop_length=HOP)[0]
    mel_db = librosa.power_to_db(
        librosa.feature.melspectrogram(y=y, sr=sr, hop_length=HOP, n_mels=64), ref=np.max
    )
    tempos = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=HOP)
    normal = tempos < inicio_anormal

    periodo = estimar_periodo(rms_db[normal], fps)
    n = int(round(periodo * fps))
    print(f"Período do ciclo normal: {periodo:.2f}s ({n} quadros)")

    limiar_silencio = np.percentile(rms_db[normal], 10) + 6  # dB
    print(f"Limiar de silêncio: {limiar_silencio:.1f} dB\n")

    feats = {
        "min_db": rolar(rms_db, n, np.min),
        "silencio": rolar(rms_db, n, lambda w: np.mean(w < limiar_silencio)),
        "flatness": rolar(np.log10(flat + 1e-10), n, np.mean),
        "semelhanca": semelhanca_ciclos(mel_db, n),
    }

    # Só avalia janelas totalmente dentro de um dos trechos
    puro_normal = tempos < inicio_anormal
    puro_anormal = tempos >= inicio_anormal + periodo

    print(f"{'feature':<11} {'normal (min..max)':>22} {'anormal (min..max)':>22} {'d':>7}  separa?")
    resumo = {}
    for nome, v in feats.items():
        a, b = v[puro_normal], v[puro_anormal]
        a, b = a[~np.isnan(a)], b[~np.isnan(b)]
        d = cohen_d(v[puro_normal], v[puro_anormal])
        # Separação perfeita: faixas não se sobrepõem
        separa = a.max() < b.min() or b.max() < a.min()
        resumo[nome] = d
        print(f"{nome:<11} {a.min():>10.3f}..{a.max():<10.3f} {b.min():>10.3f}..{b.max():<10.3f} "
              f"{d:>7.2f}  {'SIM' if separa else 'não'}")

    # Quando cada feature cruzaria pela 1ª vez a faixa normal (detecção)
    print("\nPrimeiro instante fora da faixa normal (tempo de detecção):")
    for nome, v in feats.items():
        a = v[puro_normal]
        a = a[~np.isnan(a)]
        fora = (v < a.min()) | (v > a.max())
        idx = np.where(fora & ~normal)[0]
        if len(idx):
            t = tempos[idx[0]]
            print(f"  {nome:<11} {t:6.1f}s  ({t - inicio_anormal:+.1f}s após o início anormal)")
        else:
            print(f"  {nome:<11} nunca")

    # ---- Gráficos ----
    fig, eixos = plt.subplots(3 + len(feats), 1, figsize=(16, 3.2 * (3 + len(feats))))

    librosa.display.waveshow(y, sr=sr, ax=eixos[0])
    eixos[0].set_title("Forma de onda")

    librosa.display.specshow(mel_db, sr=sr, hop_length=HOP, x_axis="time", y_axis="mel", ax=eixos[1])
    eixos[1].set_title("Mel-espectrograma")

    # Zoom na transição
    z0, z1 = max(0, inicio_anormal - 4 * periodo), duracao
    zoom = (tempos >= z0) & (tempos <= z1)
    eixos[2].imshow(mel_db[:, zoom], aspect="auto", origin="lower",
                    extent=[z0, z1, 0, mel_db.shape[0]], cmap="magma")
    eixos[2].set_title("Zoom na transição (mel)")

    for ax, (nome, v) in zip(eixos[3:], feats.items()):
        a = v[puro_normal]
        a = a[~np.isnan(a)]
        ax.plot(tempos, v)
        ax.axhspan(a.min(), a.max(), color="green", alpha=0.1, label="faixa normal")
        ax.set_title(f"{nome} (janela de {periodo:.2f}s, d = {resumo[nome]:.2f})")
        ax.legend(loc="lower left")

    for ax in eixos:
        ax.axvline(inicio_anormal, color="red", ls="--")
        if ax is not eixos[2]:
            ax.axvspan(inicio_anormal, duracao, color="red", alpha=0.12)
            ax.set_xlim(0, duracao)

    fig.tight_layout()
    fig.savefig(SAIDA, dpi=80)
    print(f"\nGráfico salvo em {SAIDA}")


if __name__ == "__main__":
    main()
