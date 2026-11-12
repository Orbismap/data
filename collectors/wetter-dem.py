"""
Geländehöhen für die Temperaturkorrektur der Wetterkarten (einmalig, ändert sich nicht).

Lädt die Terrarium-Kacheln (Mapzen/AWS Open Data, ohne Schlüssel) der Zoomstufe 5 (≈ 4,9 km), glättet sie mit einem
Boxfilter über 3 Pixel (≈ Zellgröße des Zielgitters) und rechnet sie von Web-Mercator auf dasselbe Lat/Lon-Raster um
wie die Wetterfelder (wetter-icon.py) und schreibt sie im OWX-Format (docs/WETTERDATEN-FORMAT.md im Orbis-Repo):

  <out>/v1/static/dem/o.owx            Überblick 0,5° (ganze Erde, 720 × 361)
  <out>/v1/static/dem/t<col>_<row>.owx  Kachel 45° × 45° mit 0,125° (361 × 361 mit 1 Zelle Überlappung)

Ein Zeitschritt, Meter (scale 1, offset 0, int16). Das Meer zählt als 0 m; jenseits von ±85,05° (Mercator-Grenze)
wird der Randwert fortgesetzt. Der Betrachter lädt sie über owxUrl('static', 'dem', part) wie ein Wetterfeld.
Aufruf (.github/workflows/wetter.yml, Eingabe `dem`):  python collectors/wetter-dem.py --out ../wetter-dem

Höhen: Mapzen Terrain Tiles (AWS Open Data) – u. a. SRTM, GMTED2010, ETOPO1, ArcticDEM u. a., siehe
https://github.com/tilezen/joerd/blob/master/docs/attribution.md (frei nutzbar, Namensnennung der Quellen).
Abhängigkeiten: numpy, scipy, pillow.
"""

import argparse
import concurrent.futures as cf
import importlib.util
import io
import os
import sys
import urllib.request

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('wettericon', os.path.join(HERE, 'wetter-icon.py'))
wx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wx)

Z = 5
TILES = 2**Z
PX = 256
M = TILES * PX  # 8192 Pixel um die Welt
RES = wx.RES  # 0,125°
TILE_DEG = wx.TILE_DEG
CELLS = round(TILE_DEG / RES)  # 360
URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
MERCATOR_LAT = 85.0511287798


def get_tile(x, y):
    from PIL import Image

    for i in range(4):
        try:
            req = urllib.request.Request(URL.format(z=Z, x=x, y=y), headers={'User-Agent': wx.UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                img = np.asarray(Image.open(io.BytesIO(r.read())).convert('RGB'), dtype=np.float32)
            return x, y, img[..., 0] * 256 + img[..., 1] + img[..., 2] / 256 - 32768
        except Exception as e:  # noqa: BLE001
            if i == 3:
                raise RuntimeError(f'Kachel {Z}/{x}/{y}: {e}')
    return None


def main():
    from scipy.ndimage import map_coordinates

    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    merc = np.zeros((M, M), np.float32)
    with cf.ThreadPoolExecutor(16) as ex:
        for x, y, h in ex.map(lambda a: get_tile(*a), [(x, y) for x in range(TILES) for y in range(TILES)]):
            merc[y * PX : (y + 1) * PX, x * PX : (x + 1) * PX] = h
    # Meer = 0 m – vor dem Interpolieren, sonst ziehen die Tiefenwerte der Meeresböden die Küstenpixel unter 0
    np.maximum(merc, 0, out=merc)
    print('Kacheln geladen', flush=True)

    from scipy.ndimage import uniform_filter

    merc = uniform_filter(merc, size=3, mode='nearest')
    ny, nx = round(180 / RES) + 1, round(360 / RES) + 1  # 1441 × 2881, Länge 180° doppelt (wie wetter-icon)
    lats = 90 - np.arange(ny) * RES
    lons = -180 + np.arange(nx) * RES
    fx = (lons + 180) / 360 * M - 0.5
    la = np.radians(np.clip(lats, -MERCATOR_LAT, MERCATOR_LAT))  # Pole: Randwert
    fy = (1 - np.arcsinh(np.tan(la)) / np.pi) / 2 * M - 0.5
    dem = np.empty((ny, nx), np.float32)
    for a in range(0, ny, 256):
        sel = slice(a, a + 256)
        yy, xx = np.meshgrid(fy[sel], fx, indexing='ij')
        dem[sel] = map_coordinates(merc, [yy, xx], order=1, mode='nearest')
    v = dict(scale=1.0, offset=0.0)
    q = np.clip(wx.quantize(dem, v), 0, 32000).astype(np.int16)
    over = wx.quantize(wx.overview(dem), v)

    out = os.path.join(args.out, 'v1', 'static', 'dem')
    os.makedirs(out, exist_ok=True)
    common = dict(var='dem', scale=1.0, offset=0.0, nodata=wx.NODATA, pred='plane-time')
    blobs = {'o': wx.encode(over[None], dict(common, lat0=90, lon0=-180, dx=wx.OVERVIEW_RES, dy=wx.OVERVIEW_RES, wrap=True))}
    for r in range(180 // TILE_DEG):
        for c in range(360 // TILE_DEG):
            tile = np.ascontiguousarray(q[r * CELLS : r * CELLS + CELLS + 1, c * CELLS : c * CELLS + CELLS + 1])[None]
            blobs[f't{c}_{r}'] = wx.encode(tile, dict(common, lat0=90 - r * TILE_DEG, lon0=-180 + c * TILE_DEG, dx=RES, dy=RES, wrap=False))
    total = 0
    for key, blob in blobs.items():
        with open(os.path.join(out, f'{key}.owx'), 'wb') as f:
            f.write(blob)
        total += len(blob)
    h, back = wx.decode(blobs['t3_1'])
    assert np.array_equal(back[0], q[CELLS : 2 * CELLS + 1, 3 * CELLS : 4 * CELLS + 1]), 'Selbsttest fehlgeschlagen'
    print(f'{len(blobs)} Dateien, {total / 1e6:.1f} MB, max {int(q.max())} m, Selbsttest ok')
    return 0


if __name__ == '__main__':
    sys.exit(main())
