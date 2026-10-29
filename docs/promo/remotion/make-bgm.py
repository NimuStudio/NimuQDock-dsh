"""生成一段轻电子 BGM（32 秒左右），不依赖任何外部素材。"""
import wave
import numpy as np

SR = 44100
BPM = 96
BEAT = 60 / BPM
DURATION = 34.0
N = int(SR * DURATION)

t = np.arange(N) / SR

# ---- 和弦（Am - F - C - G），每 4 拍换一次 ----
prog = [
    [220.00, 261.63, 329.63],  # A3 C4 E4
    [174.61, 220.00, 261.63],  # F3 A3 C4
    [261.63, 329.63, 392.00],  # C4 E4 G4
    [196.00, 246.94, 293.66],  # G3 B3 D4
]
pad = np.zeros(N)
for bar in range(int(np.ceil(DURATION / (4 * BEAT)))):
    start = bar * 4 * BEAT
    end = min(DURATION, start + 4 * BEAT)
    chord = prog[bar % 4]
    for f in chord:
        seg = np.zeros(N)
        a, b = int(start * SR), int(end * SR)
        seg[a:b] = np.sin(2 * np.pi * f * t[a:b]) * 0.5 + np.sin(2 * np.pi * f * 2 * t[a:b]) * 0.12
        # 慢起慢落
        env = np.ones(b - a)
        k = min(2000, (b - a) // 2)
        env[:k] = np.linspace(0, 1, k)
        env[-k:] = np.linspace(1, 0, k)
        pad[a:b] += seg[a:b] * env

# ---- 鼓 ----
def env_exp(n, rate):
    return np.exp(-np.arange(n) / SR * rate)

kick = np.zeros(N)
hat = np.zeros(N)
for beat in range(int(np.ceil(DURATION / BEAT))):
    pos = int(beat * BEAT * SR)
    if pos >= N:
        break
    # kick 每拍（1、3 拍重一点）
    if beat % 4 in (0, 2):
        n = min(int(0.28 * SR), N - pos)
        if n > 0:
            e = env_exp(n, 18)
            f = 52 * np.exp(-np.arange(n) / SR * 12) + 30
            kick[pos:pos + n] += np.sin(2 * np.pi * np.cumsum(f) / SR) * e * 0.9
    # hat 反拍
    if beat % 4 in (1, 3):
        n = min(int(0.06 * SR), N - pos)
        if n > 0:
            noise = np.random.default_rng(beat).standard_normal(n) * 0.18
            hat[pos:pos + n] += noise * env_exp(n, 80)

# ---- 低音 ----
bass = np.zeros(N)
for beat in range(int(np.ceil(DURATION / BEAT))):
    pos = int(beat * BEAT * SR)
    if pos >= N:
        break
    root = prog[(beat // 4) % 4][0] / 2
    n = min(int(BEAT * 0.9 * SR), N - pos)
    if n <= 0:
        continue
    e = env_exp(n, 6)
    bass[pos:pos + n] += np.sin(2 * np.pi * root * np.arange(n) / SR) * e * 0.35

# ---- 侧链式律动：pad 在 kick 时轻微下沉 ----
duck = np.ones(N)
for beat in range(int(np.ceil(DURATION / BEAT))):
    if beat % 4 in (0, 2):
        pos = int(beat * BEAT * SR)
        n = min(int(0.18 * SR), N - pos)
        if n > 0:
            duck[pos:pos + n] = 0.45 + 0.55 * np.linspace(0, 1, n)

pad = pad * duck * 0.28
mix = pad + kick * 0.5 + hat + bass

# 淡入淡出
fade = int(0.4 * SR)
mix[:fade] *= np.linspace(0, 1, fade)
mix[-fade:] *= np.linspace(1, 0, fade)

# 归一化
mix = mix / max(1e-9, np.max(np.abs(mix))) * 0.85
stereo = np.stack([mix, np.roll(mix, 220)], axis=1)
pcm = (stereo * 32767).astype(np.int16)

with wave.open('public/bgm.wav', 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print('bgm.wav 生成完成', pcm.shape)
