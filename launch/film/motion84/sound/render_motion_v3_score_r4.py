#!/usr/bin/env python3
"""Full 84s A-direction score. Independent music mix; does not replace a film.

Uses the candidate's original deterministic instruments and opening arrangement.
No speech, third-party samples, downloads, or production asset overwrites.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import wave

import numpy as np
import render_audio_candidates_r4 as instruments
from render_score import measure

SR=48000
SECONDS=84
ROOT=Path(__file__).resolve().parent
CHAPTERS=[
    {"id":"intro","from":0,"to":11.2,"music":"A candidate melody. Beat enters, review breathes, accepted receipt gets the harmonic lift."},
    {"id":"course","from":11.2,"to":28,"music":"Plucked pattern develops into checklist and methods; thinner at review, stronger at manual edit."},
    {"id":"agenda","from":28,"to":36.1,"music":"Brighter upper voicing and syncopated bass, then a short pickup into research."},
    {"id":"research","from":36.1,"to":45,"music":"Lower register, B-minor/add9. Fewer drums and longer melodic rests under reading."},
    {"id":"recall","from":45,"to":54.5,"music":"Three-note answering phrase, sparse pulse leaves space to inspect cited sources."},
    {"id":"capture","from":54.5,"to":60.7,"music":"Higher plucked notes and a light return of offbeat rhythm."},
    {"id":"connect","from":60.7,"to":67.9,"music":"Bass and backbeat return as the capture joins the course note."},
    {"id":"island","from":67.9,"to":74.4,"music":"Shorter phrases and articulated rhythm, no synthetic UI confirmation sounds."},
    {"id":"project","from":74.4,"to":80.4,"music":"Opening motif answers in the upper register; final rhythmic phrase resolves."},
    {"id":"finish","from":80.4,"to":84,"music":"D-major/add9 cadence and natural tail. No percussion under the final identity."},
]


def bar(s,at,root,chord,melody,energy=1,mode='full',variant=0):
    """Two-second bar. Modes change density/phrasing, not only master volume."""
    s.chord(chord,at,.058*energy,strum=True)
    if mode in ('full','lift'):
        s.chord(chord[1:],at+.75,.030*energy,strum=True)
        s.chord(chord,at+1.5,.043*energy,strum=True)
    elif mode=='read':
        s.chord(chord[1:],at+1.25,.023*energy)
    else:
        s.chord(chord[1:],at+1.5,.029*energy,strum=True)
    bass_pattern=[(0,root,.15),(1,root+7,.092)]
    if mode in ('full','lift'):bass_pattern +=[(.75,root,.07),(1.75,root+12,.062)]
    for off,n,g in bass_pattern:s.bass(n,at+off,g*energy)
    if mode in ('full','lift'):
        for off,g in [(0,.21),(1,.15),(1.75,.066)]:s.kick(at+off,g*energy)
        for off,g in [(.5,.13),(1.5,.16)]:s.snare(at+off,g*energy)
        for j in range(8):s.hat(at+j*.25,(.015 if j%2==0 else .023)*energy,(-1)**j*.25)
    elif mode=='read':
        s.kick(at,.10*energy)
        for off in [.5,1.5]:s.hat(at+off,.012*energy,.2)
    else:
        s.kick(at,.16*energy);s.snare(at+1.5,.10*energy)
        for off in [.25,.75,1.25,1.75]:s.hat(at+off,.017*energy,-.2 if off<1 else .2)
    patterns=[(0,.75,1.25,1.75),(.25,1,1.5),(0,1.25),(.5,1.5)]
    offsets=patterns[2 if mode=='read' else variant%4]
    for i,off in enumerate(offsets):
        n=melody[i%len(melody)]
        s.keys(n,at+off,(.065 if i%2==0 else .050)*energy,(-1)**i*.17,bright=mode in ('lift','full'))
        if mode=='lift' and i==0:s.string(n-12,at+off,.027,-.2)


def compose():
    instruments.DURATION=SECONDS
    s=instruments.arrange_a()[0]  # Original A opening, now with uncut decays after 15s.
    # D/add9, G/maj9, Bm7, A/sus2. Each chapter develops its own phrase.
    harmony=[(38,(57,62,66,69)),(43,(55,59,62,69)),(35,(54,57,61,66)),(45,(57,59,64,69))]
    for idx,at in enumerate(range(16,28,2)):
        root,chord=harmony[(idx+1)%4]
        mode='read' if at in (22,) else 'full'
        energy=.60 if mode=='read' else (1.02 if at>=24 else .92)
        bar(s,at,root,chord,(74,78,76,71) if idx%2==0 else (69,71,74),energy,mode,idx)
    for idx,at in enumerate(range(28,36,2)):
        root,chord=harmony[(idx+1)%4]
        bar(s,at,root,chord,(79,78,74,76) if idx%2==0 else (78,76,74),.95,'lift',idx)
    s.snare(35.25,.049);s.snare(35.5,.062);s.hat(35.75,.018,.22)
    research=[(35,(54,57,61,66)),(43,(55,59,62,66)),(38,(54,57,62,64)),(45,(57,59,64,69)),(43,(55,59,62,69))]
    for idx,at in enumerate(range(36,46,2)):
        root,chord=research[idx]
        bar(s,at,root,chord,(69,73,66) if idx%2 else (71,69,66),.74,'read' if idx%2==0 else 'light',2)
    for idx,at in enumerate(range(46,54,2)):
        root,chord=harmony[idx%4]
        bar(s,at,root,chord,(74,71,69) if idx%2 else (76,74),.72,'read',2)
        if idx in (1,3):s.string(78,at+1.5,.049,.24)
    for idx,at in enumerate(range(54,62,2)):
        root,chord=harmony[(idx+1)%4]
        bar(s,at,root,chord,(74,76,78) if idx%2==0 else (79,78,74),.82,'light',idx)
        s.string(81 if idx%2 else 78,at+.75,.045,.25)
    for idx,at in enumerate(range(62,68,2)):
        root,chord=harmony[(idx+2)%4]
        bar(s,at,root,chord,(76,78,81,78),.94,'full',idx)
    for idx,at in enumerate(range(68,74,2)):
        root,chord=harmony[idx%4]
        bar(s,at,root,chord,(78,74,76) if idx%2 else (74,76,78),.94,'lift',1 if idx%2 else 0)
    for idx,at in enumerate(range(74,80,2)):
        root,chord=harmony[(idx+1)%4]
        bar(s,at,root,chord,(81,78,76,74) if idx<2 else (76,73,69),1.02,'lift',idx)
    # Scene cues are musical joins, not a UI click every time the screen changes.
    for at,n in [(28.0,79),(45.0,74),(54.5,78),(60.75,81),(68.0,78),(74.5,81)]:
        s.keys(n,at,.048,.16,bright=True)
    # Cadence follows the actual 80.4s title card, then leaves a clean ending.
    s.bass(38,80.4,.16,length=1.1)
    for i,n in enumerate((57,62,66,69,76)):
        s.keys(n,80.4+i*.033,.073 if i<4 else .09,-.34+i*.17,length=3.5)
    s.keys(74,81.18,.078,.12,length=2.7)
    t=np.arange(round(3.6*SR))/SR
    for i,n in enumerate((62,66,69)):
        f=440*2**((n-69)/12)
        y=(np.sin(2*np.pi*f*t)+.25*np.sin(2*np.pi*f*1.001*t))
        env=(1-np.exp(-t/.035))*np.exp(-t/.85)*np.minimum(1,(3.6-t)/.4)**2
        s.add(y*env,80.4,.018,-.3+i*.3)
    return s.mix


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output',type=Path,default=ROOT/'output')
    p.add_argument('--ffmpeg',default='ffmpeg')
    args=p.parse_args();args.output.mkdir(parents=True,exist_ok=True)
    data=compose();data-=data.mean(axis=0)
    t=np.arange(len(data))/SR
    env=np.sin(np.minimum(1,t/.018)*np.pi/2)**2
    env*=np.sin(np.clip((SECONDS-1/SR-t)/.7,0,1)*np.pi/2)**2
    data*=env[:,None]
    before=measure(args.ffmpeg,data)
    gain=min(-18.5-before['integrated_lufs'],-2.0-before['true_peak_dbfs'])
    data*=10**(gain/20)
    metrics=measure(args.ffmpeg,data)
    if not np.isfinite(data).all() or np.max(np.abs(data))>=1:raise ValueError('Invalid/clip')
    wav=args.output/'aibro-motion-r4-music.wav'
    with wave.open(str(wav),'wb') as f:
        f.setnchannels(2);f.setsampwidth(2);f.setframerate(SR)
        f.writeframes(np.rint(data*32767).astype('<i2').tobytes())
    for extension,codec,bitrate in [('mp3','libmp3lame','256k'),('m4a','aac','256k')]:
        subprocess.run([args.ffmpeg,'-v','error','-y','-i',str(wav),'-c:a',codec,'-b:a',bitrate,str(wav.with_suffix('.'+extension))],check=True)
    metrics.update({'duration_seconds':SECONDS,'bpm':120,'sample_rate':SR,'channels':2,
        'direction':'A, selected by user from 15s candidates. Full 84s mix is not listening-accepted.',
        'speech':False,'source':'Original deterministic oscillator/noise music. No external samples or recordings.',
        'production_overwritten':False,'normalization_gain_db':gain,'clipped_samples':int(np.count_nonzero(np.abs(data)>=1)),
        'sample_peak_dbfs':float(20*np.log10(np.max(np.abs(data)))),
        'chapters':[dict(c,rms_dbfs=round(float(20*np.log10(np.sqrt(np.mean(data[round(c['from']*SR):round(c['to']*SR)]**2)))),2)) for c in CHAPTERS],
        'files':{f.name:{'sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'bytes':f.stat().st_size} for f in [wav,wav.with_suffix('.mp3'),wav.with_suffix('.m4a')]},
        'verification':'Numerical and decode integrity only. No claim of auditory review.'})
    (args.output/'report.json').write_text(json.dumps(metrics,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(metrics,ensure_ascii=False,indent=2))


if __name__=='__main__':main()
