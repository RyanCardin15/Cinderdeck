"""Original restrained electronic score, synthesized locally; no third-party audio."""
from pathlib import Path
import wave
import numpy as np
rate, duration = 48000, 48
mix = np.zeros((rate * duration, 2), dtype=np.float64)
def note(midi, start, length, gain, pan=0.0, pad=False):
    first, count = int(start * rate), int(length * rate)
    count = min(count, len(mix) - first)
    if count <= 0: return
    t = np.arange(count) / rate
    freq = 440 * 2 ** ((midi-69)/12)
    signal = np.sin(2*np.pi*freq*t) + .22*np.sin(2*np.pi*freq*2*t)
    envelope = np.minimum(t/(.45 if pad else .012), 1) * np.minimum((length-t)/(.6 if pad else .08), 1)
    if not pad: envelope *= np.exp(-t*4)
    signal *= np.maximum(0,envelope)*gain
    mix[first:first+count,0] += signal * (.7-pan*.3)
    mix[first:first+count,1] += signal * (.7+pan*.3)
chords = [(50,57,65,69),(46,53,62,65),(53,60,65,69),(48,55,64,67)]
for bar in range(20):
    chord=chords[bar%4]
    for i,n in enumerate(chord): note(n,bar*2.4,2.8,.022,(i-1.5)/2,pad=True)
    for step in range(8):
        note(chord[(step+bar)%4]+12,bar*2.4+step*.3,.65,.025,(-1 if step%2 else 1)*.5)
    for beat in range(4): note(chord[0]-12,bar*2.4+beat*.6,.22,.025)
# Soft tonal markers on chapter cuts.
for start in [3.6,11.6,18.6,24.6,32.6,44.0]:
    note(81,start,.8,.025,-.2); note(88,start+.12,.75,.018,.2)
t=np.arange(len(mix))/rate
mix *= (np.minimum(t/1.1,1)*np.clip((duration-t)/2,0,1))[:,None]
mix = np.tanh(mix * 1.7)
output=Path(__file__).resolve().parents[1]/'public'/'score.wav'
with wave.open(str(output),'wb') as f:
    f.setnchannels(2); f.setsampwidth(2); f.setframerate(rate)
    f.writeframes((mix*32767).astype('<i2').tobytes())
print(output)
