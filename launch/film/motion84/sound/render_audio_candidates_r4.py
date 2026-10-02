#!/usr/bin/env python3
"""Two original 15-second soundtrack candidates, never overwriting released audio.

No recordings, third-party samples, speech, network, or paid services. All sounds
are deterministic oscillator/noise synthesis. Requires bundled numpy and FFmpeg.
The old film is pure instrumental music; these are arrangement alternatives,
not time-stretched copies. Auditory preference still requires human audition.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import subprocess
import wave

import numpy as np
from render_score import measure

SR = 48000
DURATION = 15
ROOT = Path(__file__).resolve().parent
TARGET_LUFS = -18.5


class Score:
    def __init__(self, seed):
        self.rng = np.random.default_rng(seed)
        self.mix = np.zeros((SR * DURATION, 2), dtype=np.float64)

    def add(self, y, at, gain=1, pan=0):
        offset = round(at * SR)
        if offset < 0:
            y, offset = y[-offset:], 0
        n = min(len(y), len(self.mix) - offset)
        if n <= 0:
            return
        a = (pan + 1) * math.pi / 4
        self.mix[offset:offset+n] += y[:n, None] * np.array([math.cos(a), math.sin(a)]) * gain

    def noise(self, seconds, lo, hi):
        n = round(seconds * SR)
        f = np.fft.rfftfreq(n, 1 / SR)
        mask = (1 - np.exp(-(f / lo) ** 4)) * np.exp(-(f / hi) ** 4)
        y = np.fft.irfft(np.fft.rfft(self.rng.standard_normal(n)) * mask, n=n)
        return y / max(np.sqrt(np.mean(y*y)), 1e-9)

    def keys(self, note, at, gain, pan=0, length=1.0, bright=False):
        t = np.arange(round(length*SR)) / SR
        f = 440 * 2 ** ((note-69)/12)
        # Soft FM tine, with a short overtone bloom rather than a pure sine bleep.
        p = 2 * np.pi * f * t
        index = (1.15 if bright else .62) * np.exp(-t / .09)
        y = np.sin(p + index * np.sin(2*p + .18)) * np.exp(-t / .31)
        y += .17 * np.sin(p*3.001) * np.exp(-t/.07)
        env = (1-np.exp(-t/.004)) * np.minimum(1, (length-t)/.08)**2
        y *= env
        self.add(y, at, gain, pan)
        self.add(y, at+.147, gain*.065, -pan)
        self.add(y, at+.291, gain*.025, pan)

    def string(self, note, at, gain, pan=0, length=.8):
        t = np.arange(round(length*SR)) / SR
        f = 440 * 2 ** ((note-69)/12)
        y = np.zeros_like(t)
        for h in range(1, 9):
            # Pick location shapes the harmonics. Upper partials decay quickly.
            y += np.sin(h*.27*np.pi) / (h**1.25) * np.sin(2*np.pi*f*h*t) * np.exp(-t/(.39/(h**.47)))
        env = (1-np.exp(-t/.0018)) * np.minimum(1, (length-t)/.09)**2
        self.add(y*env, at, gain, pan)

    def bass(self, note, at, gain, length=.28):
        t = np.arange(round(length*SR))/SR
        p = 2*np.pi * 440*2**((note-69)/12)*t
        y = np.sin(p) + .23*np.sin(2*p) + .07*np.sin(3*p)
        env = (1-np.exp(-t/.004))*np.exp(-t/.18)*np.minimum(1,(length-t)/.03)**2
        self.add(y*env, at, gain)

    def kick(self, at, gain):
        t = np.arange(round(.22*SR))/SR
        p = 2*np.pi*(51*t + 78*.012*(1-np.exp(-t/.012)))
        y = np.sin(p)*np.exp(-t/.047)*(1-np.exp(-t/.0007))
        y += self.noise(.22, 1700, 4200)*.055*np.exp(-t/.003)
        self.add(y*np.minimum(1,(.22-t)/.04)**2, at, gain)

    def snare(self, at, gain, clap=False):
        t = np.arange(round(.19*SR))/SR
        y = self.noise(.19, 950, 6500)
        env = (1-np.exp(-t/.0006))*np.exp(-t/.022)
        if clap:
            env += .55*np.maximum(0, np.sign(t-.011))*np.exp(-np.maximum(0,t-.011)/.019)
            env += .35*np.maximum(0, np.sign(t-.023))*np.exp(-np.maximum(0,t-.023)/.027)
        y = .28*y*env + .17*np.sin(2*np.pi*190*t)*np.exp(-t/.019)
        self.add(y*np.minimum(1,(.19-t)/.03)**2, at, gain, .035)

    def hat(self, at, gain, pan=0, open=False):
        length = .13 if open else .052
        t = np.arange(round(length*SR))/SR
        y = self.noise(length, 4300, 10500)
        env = (1-np.exp(-t/.0005))*np.exp(-t/(.031 if open else .009))
        self.add(y*env*np.minimum(1,(length-t)/.014)**2, at, gain, pan)

    def chord(self, notes, at, gain, bright=False, strum=False):
        for i, note in enumerate(notes):
            if strum:
                self.string(note, at+i*.016, gain, -.36+i*.24)
            else:
                self.keys(note, at+i*.011, gain, -.3+i*.2, bright=bright)


def arrange_a():
    s = Score(20261002120)
    # 120 BPM, open major/add9 harmony, articulated strum and a two-bar melody.
    beat = .5
    chords = [(38,(57,62,66,69)),(43,(55,59,62,69)),(35,(54,57,61,66)),(45,(57,59,64,69))]
    for b in range(8):
        start = b*2.0
        root, chord = chords[b % 4]
        strength = .58 if start < 2 else .94
        if 6 <= start < 8:
            strength = .40  # Leave room to read the review rather than continuous drums.
        s.chord(chord, start, .063*strength, strum=True)
        if start >= 2:
            s.chord(chord[1:], start+.75, .035*strength, strum=True)
            s.chord(chord, start+1.5, .046*strength, strum=True)
        for off, note, g in [(0,root,.17),(.75,root,.09),(1,root+7,.10),(1.75,root+12,.065)]:
            s.bass(note,start+off,g*strength)
        if start < 6 or start >= 8:
            for off,g in [(0,.23),(1,.16),(1.75,.075)]: s.kick(start+off,g*strength)
            if start>=2:
                s.snare(start+.5,.14*strength); s.snare(start+1.5,.18*strength)
            for j in range(8): s.hat(start+j*.25,.015 if j%2==0 else .025,(-1)**j*.25)
        else:
            for off in [.5,1.5]: s.hat(start+off,.014,.18)
        phrase = [(0,74,.071),(.75,76,.06),(1.25,78,.073),(1.75,76,.045)] if b%2==0 else [(.25,74,.07),(1,71,.06),(1.5,69,.046)]
        if b == 3: phrase=[(.5,73,.05),(1.5,69,.035)]
        for off,n,g in phrase: s.keys(n,start+off,g*strength, -.18 if n%2 else .18,bright=True)
    # Actual saved receipt becomes visible around 8.65, never accent an earlier false success.
    s.chord((62,66,69,76),8.75,.058,bright=True)
    s.hat(8.75,.022,.2,open=True)
    # New source/task chapter at 11.2 and 13.5 is a musical lift, not a reset loop.
    s.keys(81,11.25,.075,.1,bright=True)
    s.keys(78,11.75,.061,-.16,bright=True)
    s.snare(13.25,.065); s.snare(13.375,.08)
    return s,120,"A · 清亮律动 / Clear, rhythmic",[
        {"at":0,"action":"Plucked opening, clear melodic question"},
        {"at":2,"action":"Bass, hats and backbeat build into processing"},
        {"at":6,"action":"Drop drums and thin harmony for review"},
        {"at":8.75,"action":"Major/add9 lift after actual accepted receipt"},
        {"at":11.25,"action":"High melodic response into source and task scenes"}]


def arrange_b():
    s=Score(20261002128)
    beat=60/128
    # 128 BPM, syncopated electric keys and tighter beat. Different melody/harmony.
    chords=[(41,(60,64,67,72)),(36,(55,60,64,69)),(38,(57,62,65,69)),(43,(59,62,67,69))]
    for b in range(8):
        start=b*beat*4
        root,chord=chords[b%4]
        for off,g in [(0,.060),(1.5,.041),(2.75,.054)]:
            s.chord(chord,start+off*beat,g,bright=True)
        for off,n,g in [(0,root,.17),(.75,root,.065),(1.5,root+12,.1),(2.5,root+7,.13),(3.5,root,.1)]:
            s.bass(n,start+off*beat,g)
        if b != 3:
            for off,g in [(0,.24),(1.5,.10),(2,.19),(3.5,.12)]: s.kick(start+off*beat,g)
            for off in [1,3]: s.snare(start+off*beat,.14,clap=True)
            for j in range(8):s.hat(start+j*beat*.5,.019 if j%2 else .010,(-1)**j*.32,open=j==7)
        else:
            # Short pressure release before the saved result. Pulse stays legible.
            s.kick(start,.10);s.hat(start+beat,.016,.25);s.hat(start+beat*3,.016,-.25)
        motif=[(.5,79),(1.75,76),(2.5,72),(3.25,74)] if b%2==0 else [(0,76),(1.5,79),(2.25,81),(3.25,79)]
        for i,(off,n) in enumerate(motif): s.string(n,start+off*beat,.068 if i%2 else .08,(-1)**i*.2)
    # Off-grid visual cue gets a pitched accent, not a disruptive extra kick.
    s.chord((60,64,67,74),8.68,.055,bright=True)
    s.keys(84,11.2,.067,.12,bright=True)
    s.snare(13.125,.08,clap=True);s.hat(13.5,.036,-.15,open=True)
    return s,128,"B · 明快推进 / Brisk momentum",[
        {"at":0,"action":"Immediate syncopated keys and articulated rhythm"},
        {"at":3.75,"action":"Melody develops above processing pulse"},
        {"at":5.625,"action":"One-bar breathing space for draft review"},
        {"at":8.68,"action":"Harmonic accent after actual accepted receipt"},
        {"at":11.2,"action":"Fresh higher register as the course source opens"}]


def export(score,bpm,title,cues,path,ffmpeg):
    data=score.mix
    data-=data.mean(axis=0)
    t=np.arange(len(data))/SR
    envelope=np.sin(np.minimum(1,t/.018)*np.pi/2)**2
    envelope*=np.sin(np.clip((DURATION-1/SR-t)/.40,0,1)*np.pi/2)**2
    data*=envelope[:,None]
    before=measure(ffmpeg,data)
    gain=min(TARGET_LUFS-before['integrated_lufs'],-2.0-before['true_peak_dbfs'])
    data*=10**(gain/20)
    metrics=measure(ffmpeg,data)
    if not np.isfinite(data).all() or np.max(np.abs(data))>=1: raise ValueError('Invalid or clipped mix')
    with wave.open(str(path),'wb') as f:
        f.setnchannels(2);f.setsampwidth(2);f.setframerate(SR)
        f.writeframes(np.rint(data*32767).astype('<i2').tobytes())
    subprocess.run([ffmpeg,'-v','error','-y','-i',str(path),'-c:a','libmp3lame','-b:a','256k',str(path.with_suffix('.mp3'))],check=True)
    f=np.fft.rfftfreq(len(data),1/SR)
    power=np.sum(np.abs(np.fft.rfft(data,axis=0))**2,axis=1)
    metrics.update({
        'title':title,'bpm':bpm,'seconds':DURATION,'sample_rate':SR,'channels':2,
        'sample_peak_dbfs':float(20*np.log10(np.max(np.abs(data)))),
        'clipped_samples':int(np.count_nonzero(np.abs(data)>=1)),
        'energy_above_2500hz':float(power[f>2500].sum()/power.sum()),
        'energy_above_5000hz':float(power[f>5000].sum()/power.sum()),
        'three_second_rms_dbfs':[round(float(20*np.log10(np.sqrt(np.mean(data[i*SR:(i+3)*SR]**2)))),2) for i in range(0,15,3)],
        'wav_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
        'mp3_sha256':hashlib.sha256(path.with_suffix('.mp3').read_bytes()).hexdigest(),
        'cue_design':cues,'hearing_review':'Not performed by agent; samples require listening preference review.',
    })
    return metrics


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output',type=Path,default=ROOT/'candidates')
    p.add_argument('--ffmpeg',default='ffmpeg')
    args=p.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    result={'candidate_only':True,'released_audio_modified':False,'speech':False,'seconds':15,'candidates':[]}
    for label,arrange in [('a-clear-rhythm',arrange_a),('b-brisk-momentum',arrange_b)]:
        score,bpm,title,cues=arrange()
        result['candidates'].append(export(score,bpm,title,cues,args.output/(label+'.wav'),args.ffmpeg))
    (args.output/'report.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(result,ensure_ascii=False,indent=2))
