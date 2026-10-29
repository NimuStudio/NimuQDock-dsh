"""轻快版 BGM：104 BPM，C-G-Am-F，拨弦+轻打击，不带重低音。"""
import wave
import numpy as np

SR = 44100
BPM = 104
BEAT = 60 / BPM
DURATION = 156.0
N = int(SR * DURATION)
t = np.arange(N) / SR

# C - G - Am - F
prog = [
    [261.63, 329.63, 392.00],  # C
    [196.00, 246.94, 293.66],  # G
    [220.00, 261.63, 329.63],  # Am
    [174.61, 220.00, 261.63],  # F
]


def pluck(freq, dur=0.9, amp=0.3):
    n = int(dur * SR)
    x = np.arange(n) / SR
    env = np.exp(-x * 6.5)
    tone = np.sin(2 * np.pi * freq * x) + 0.35 * np.sin(2 * np.pi * freq * 2 * x)
    return tone * env * amp


mix = np.zeros(N)
# 拨弦琶音：每八分音符一个音，轻快
for step in range(int(DURATION / (BEAT / 2))):
    pos = int(step * BEAT / 2 * SR)
    if pos >= N:
        break
    chord = prog[(step // 8) % 4]
    note = chord[step % 3]
    octave = 2 if step % 4 == 0 else 1
    seg = pluck(note * octave, 0.8, 0.22 if octave == 2 else 0.18)
    end = min(N, pos + len(seg))
    mix[pos:end] += seg[:end - pos]

# 柔和铺底
for bar in range(int(np.ceil(DURATION / (4 * BEAT)))):
    start = int(bar * 4 * BEAT * SR)
    end = min(N, int((bar + 1) * 4 * BEAT * SR))
    if start >= N:
        break
    chord = prog[bar % 4]
    x = np.arange(end - start) / SR
    pad = sum(np.sin(2 * np.pi * f * x) for f in chord) * 0.045
    env = np.ones(len(x))
    k = min(3000, len(x) // 2)
    if k > 0:
        env[:k] = np.linspace(0, 1, k)
        env[-k:] = np.linspace(1, 0, k)
    mix[start:end] += pad * env

# 轻打击：沙锤 + 拍手
rng = np.random.default_rng(7)
for beat in range(int(DURATION / BEAT)):
    pos = int(beat * BEAT * SR)
    if pos >= N:
        break
    # 沙锤（每半拍）
    for half in (0, 0.5):
        p = int((beat + half) * BEAT * SR)
        n = min(int(0.05 * SR), N - p)
        if n > 0:
            noise = rng.standard_normal(n) * 0.06
            env = np.exp(-np.arange(n) / SR * 120)
            mix[p:p + n] += noise * env
    # 柔和的底鼓，每两拍
    if beat % 2 == 0:
        n = min(int(0.22 * SR), N - pos)
        if n > 0:
            e = np.exp(-np.arange(n) / SR * 22)
            f = 70 * np.exp(-np.arange(n) / SR * 16) + 42
            mix[pos:pos + n] += np.sin(2 * np.pi * np.cumsum(f) / SR) * e * 0.28

# 简单旋律（高音铃音），每两小节一句
melody = [659.25, 783.99, 880.00, 783.99, 659.25, 587.33, 523.25, 587.33]
for i, f in enumerate(melody * 2):
    pos = int((i * 2 * BEAT + BEAT) * SR)
    n = min(int(0.7 * SR), N - pos)
    if n <= 0:
        break
    x = np.arange(n) / SR
    env = np.exp(-x * 4)
    mix[pos:pos + n] += np.sin(2 * np.pi * f * x) * env * 0.10

# 淡入淡出 + 归一化
fade = int(0.5 * SR)
mix[:fade] *= np.linspace(0, 1, fade)
mix[-fade:] *= np.linspace(1, 0, fade)
mix = mix / max(1e-9, np.max(np.abs(mix))) * 0.8
stereo = np.stack([mix, np.roll(mix, 180)], axis=1)
pcm = (stereo * 32767).astype(np.int16)

with wave.open('public/bgm.wav', 'wb') as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print('新 BGM 完成')
