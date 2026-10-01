#!/usr/bin/env python3
"""Render AI Bro's original 42-second rhythmic product-film score.

Requires Python 3, numpy, and FFmpeg. No samples, speech, or network services.
Deterministic oscillator/noise synthesis: 48 kHz stereo PCM16, target -19 LUFS.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import wave

import numpy as np

SR = 48_000
DURATION = 42.0
SEED = 20261001
BPM = 120
BEAT = 60 / BPM
TARGET_LUFS = -19.0
TRUE_PEAK_LIMIT = -2.4
RNG = np.random.default_rng(SEED)
mix = np.zeros((int(SR * DURATION), 2), dtype=np.float64)
CUES = (0, .6, 1.8, 3.4, 5, 6.5, 8.5, 10.5, 12, 14.2, 17,
        20, 22.2, 25, 26.6, 29, 31.5, 34, 36, 36.7, 37.4, 39)


def hz(midi: float) -> float:
    return 440 * 2 ** ((midi - 69) / 12)


def clock(duration: float) -> np.ndarray:
    return np.arange(round(SR * duration), dtype=np.float64) / SR


def add(signal: np.ndarray, start: float, gain: float, pan: float = 0) -> None:
    offset = round(start * SR)
    if offset < 0:
        signal = signal[-offset:]
        offset = 0
    length = min(len(signal), len(mix) - offset)
    if length <= 0:
        return
    angle = (pan + 1) * math.pi / 4
    mix[offset:offset + length, 0] += signal[:length] * gain * math.cos(angle)
    mix[offset:offset + length, 1] += signal[:length] * gain * math.sin(angle)


def noise(duration: float, low: float, high: float) -> np.ndarray:
    """Band-limited seeded noise with smooth spectral shoulders."""
    count = round(SR * duration)
    spectrum = np.fft.rfft(RNG.standard_normal(count))
    freq = np.fft.rfftfreq(count, 1 / SR)
    taper = (1 - np.exp(-(freq / low) ** 4)) * np.exp(-(freq / high) ** 4)
    value = np.fft.irfft(spectrum * taper, n=count)
    return value / max(float(np.sqrt(np.mean(value ** 2))), 1e-9)


def key(midi: int, start: float, gain: float, pan: float = 0, length: float = 2.2) -> None:
    t = clock(length)
    f = hz(midi)
    value = np.zeros_like(t)
    for multiple, strength, decay in ((1, 1, .65), (2.002, .19, .24), (3.005, .045, .13)):
        value += np.sin(2 * math.pi * f * multiple * t) * strength * np.exp(-t / decay)
    env = (1 - np.exp(-t / .009)) * np.minimum(1, (length - t) / .25) ** 2
    value *= env
    add(value, start, gain, pan)
    # Small stereo reflections retain clarity around fast title cuts.
    add(value, start + .188, gain * .10, -pan)
    add(value, start + .376, gain * .04, pan)


def pad(midi: int, start: float, length: float, gain: float, pan: float) -> None:
    t = clock(length)
    f = hz(midi)
    value = np.zeros_like(t)
    for cents, strength in ((-3, .4), (2, .6)):
        value += strength * np.sin(2 * math.pi * f * 2 ** (cents / 1200) * t + RNG.uniform(0, 2 * math.pi))
    env = np.sin(np.minimum(1, t / .45) * math.pi / 2) ** 2
    env *= np.sin(np.minimum(1, (length - t) / 1.2) * math.pi / 2) ** 2
    add(value * env, start, gain, pan)


def bass(midi: int, start: float, gain: float, length: float = .55) -> None:
    t = clock(length)
    phase = 2 * math.pi * hz(midi) * t
    value = (np.sin(phase) + .16 * np.sin(phase * 2)) * (1 - np.exp(-t / .017))
    value *= np.exp(-t / .24) * np.minimum(1, (length - t) / .08) ** 2
    add(value, start, gain)


def kick(start: float, gain: float) -> None:
    t = clock(.28)
    # Rounded pitch descent, without a sharp high-frequency click.
    phase = 2 * math.pi * (49 * t + 58 * .016 * (1 - np.exp(-t / .016)))
    env = (1 - np.exp(-t / .002)) * np.exp(-t / .055)
    env *= np.minimum(1, (.28 - t) / .06) ** 2
    add(np.sin(phase) * env, start, gain)


def tap(start: float, gain: float, pan: float = 0, soft: bool = False) -> None:
    t = clock(.12)
    value = noise(.12, 450 if soft else 700, 2200 if soft else 3800)
    env = (1 - np.exp(-t / .0015)) * np.exp(-t / (.019 if soft else .012))
    env *= np.minimum(1, (.12 - t) / .02) ** 2
    # Low woody body makes the noise transient feel tactile, not like a bleep.
    body = np.sin(2 * math.pi * 185 * t) * np.exp(-t / .014)
    add((.40 * value + .35 * body) * env, start, gain, pan)


def brush(start: float, gain: float, pan: float) -> None:
    t = clock(.10)
    env = (1 - np.exp(-t / .002)) * np.exp(-t / .012)
    env *= np.minimum(1, (.10 - t) / .02) ** 2
    add(noise(.10, 2100, 6500) * env, start, gain, pan)


def sweep(cue: float, gain: float, pan: float = 0) -> None:
    length = .36
    t = clock(length)
    env = np.sin(math.pi * t / length) ** 2
    env *= .7 + .3 * t / length
    add(noise(length, 500, 2100) * env, cue - .25, gain, pan)


def compose() -> None:
    # Bright D-major/add-nine harmony; each main product chapter has a fresh color.
    sections = (
        (0, 5, 38, (57, 62, 66, 69), (74, 69, 66, 76)),
        (5, 12, 38, (57, 62, 66, 69), (74, 76, 69, 66)),
        (12, 20, 43, (55, 59, 62, 69), (71, 74, 69, 66)),
        (20, 25, 35, (54, 57, 61, 66), (73, 69, 66, 74)),
        (25, 29, 45, (57, 61, 64, 71), (71, 73, 76, 69)),
        (29, 36, 43, (55, 59, 62, 69), (74, 71, 69, 76)),
        (36, 39, 45, (57, 61, 64, 71), (73, 71, 69, 76)),
        (39, 42, 38, (57, 62, 66, 69), (74, 69, 66, 62)),
    )
    for section, (start, end, root, chord, melody) in enumerate(sections):
        for voice, note in enumerate(chord):
            pad(note, start, end - start + 1.05, .013, -.65 + voice * .43)
        # Short chord arpeggios bring an affirmative shape to each reveal.
        for voice, note in enumerate(chord):
            key(note, start + voice * .043, .033 if section > 0 else .025, -.3 + voice * .2)
        if section == 0:
            for moment, note in zip((.6, 1.8, 3.4), melody):
                key(note, moment, .066, -.12 if note % 2 else .12)
            continue
        if section == 7:
            bass(root, 39, .16, 1.5)
            key(74, 39.06, .075, .12, 2.75)
            key(78, 39.15, .035, -.12, 2.65)
            continue
        pulse = start
        count = 0
        while pulse < end - .28:
            # Alternating roots and fifths; rests on every fourth beat.
            if count % 4 != 3:
                bass(root if count % 4 != 2 else root + 7, pulse, .105 if count % 4 == 0 else .067)
            if count % 2 == 0:
                key(melody[(count // 2) % 4], pulse + .125,
                    .048 if count % 4 == 0 else .036, (-.2, .15, -.1, .22)[(count // 2) % 4])
            pulse += BEAT
            count += 1

    # Half-time groove, rather than a busy dance or videogame arrangement.
    bar = 5.0
    while bar < 35.9:
        for offset, gain in ((0, .17), (.75, .066), (1.5, .10)):
            if bar + offset < 36:
                kick(bar + offset, gain)
        tap(bar + 1, .086, .06, soft=True)
        for index, offset in enumerate((.25, .75, 1.25, 1.75)):
            if bar + offset < 36:
                brush(bar + offset, .021 if index % 2 == 0 else .028, -.27 if index % 2 else .27)
        bar += 2

    # The opening and value cards are deliberately sparse and synchronized.
    for index, cue in enumerate(CUES):
        major = cue in (5, 12, 20, 25, 29, 39)
        tap(cue, .038 if major else .027, -.12 if index % 2 else .12, soft=True)
        if major:
            sweep(cue, .0065, -.17 if index % 2 else .17)
    for cue in (36, 36.7, 37.4):
        kick(cue, .055)


def measure(ffmpeg: str, data: np.ndarray) -> dict:
    result = subprocess.run(
        [ffmpeg, '-hide_banner', '-nostats', '-f', 'f64le', '-ar', str(SR),
         '-ac', '2', '-i', 'pipe:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'],
        input=data.astype('<f8').tobytes(), stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        check=True,
    )
    summary = result.stderr.decode().rsplit('Summary:', 1)[-1]
    return {
        'integrated_lufs': float(re.search(r'I:\s+(-?[\d.]+) LUFS', summary).group(1)),
        'loudness_range_lu': float(re.search(r'LRA:\s+(-?[\d.]+) LU', summary).group(1)),
        'true_peak_dbfs': float(re.search(r'Peak:\s+(-?[\d.]+) dBFS', summary).group(1)),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path,
                        default=Path(__file__).resolve().parents[2] / 'dist/assets/film/score.wav')
    parser.add_argument('--ffmpeg', default=shutil.which('ffmpeg'))
    args = parser.parse_args()
    if not args.ffmpeg:
        parser.error('FFmpeg is required for measured loudness normalization.')
    compose()
    # Gentle stereo reflections; no compressor pumping, distortion, or hard limiter.
    dry = mix.copy()
    for delay, gain in ((.061, .036), (.103, .02)):
        shift = round(delay * SR)
        mix[shift:] += dry[:-shift, ::-1] * gain
    mix[:] -= mix.mean(axis=0)
    t = np.arange(len(mix)) / SR
    fade_in = np.sin(np.minimum(1, t / .045) * math.pi / 2) ** 2
    fade_out = np.sin(np.minimum(1, np.maximum(0, (DURATION - 1 / SR) - t) / 2.0) * math.pi / 2) ** 2
    mix[:] *= (fade_in * fade_out)[:, None]
    before = measure(args.ffmpeg, mix)
    gain_db = min(TARGET_LUFS - before['integrated_lufs'], TRUE_PEAK_LIMIT - before['true_peak_dbfs'])
    mix[:] *= 10 ** (gain_db / 20)
    if np.max(np.abs(mix)) >= 1:
        raise RuntimeError('Normalization unexpectedly exceeded PCM headroom.')
    pcm = np.round(mix * 32767).astype('<i2')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(args.output), 'wb') as stream:
        stream.setnchannels(2)
        stream.setsampwidth(2)
        stream.setframerate(SR)
        stream.writeframes(pcm.tobytes())
    final = pcm.astype(np.float64) / 32768
    report = {
        'file': args.output.name,
        'duration_seconds': DURATION,
        'sample_rate': SR,
        'channels': 2,
        'format': 'PCM signed 16-bit little endian',
        'seed': SEED,
        'tempo_bpm': BPM,
        'arrangement': 'Original rounded keys, major/add-nine harmony, half-time percussion, tactile scene accents.',
        'scene_accents_seconds': CUES,
        'normalization_gain_db': round(gain_db, 3),
        **measure(args.ffmpeg, final),
        'sample_peak_dbfs': round(20 * math.log10(float(np.max(np.abs(final)))), 3),
        'rms_dbfs': round(20 * math.log10(float(np.sqrt(np.mean(final ** 2)))), 3),
        'stereo_correlation': round(float(np.corrcoef(final.T)[0, 1]), 4),
        'clipped_samples': int(np.count_nonzero(np.abs(pcm.astype(np.int32)) >= 32767)),
        'first_frame': pcm[0].tolist(),
        'last_frame': pcm[-1].tolist(),
        'sha256': hashlib.sha256(args.output.read_bytes()).hexdigest(),
        'source': 'Original deterministic mathematical synthesis; no external recordings or samples.',
        'verification': 'Numerical integrity and FFmpeg loudness analysis only; not human-listening acceptance.',
    }
    (Path(__file__).parent / 'score-report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
