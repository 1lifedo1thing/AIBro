"""Loudness helper shared by the original synthesized score."""
import re
import subprocess
import numpy as np
SR=48000

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

