#!/usr/bin/env python3
"""Macht aus dem Natural-Earth-Landbedeckungsraster (NE2_HR_LC) ein Vektor-Overlay: Flächen pro Landschaftsklasse.
1. jedes Pixel der nächstliegenden bekannten Landschaft zuordnen (Wüste, Steppe, Savanne, Laubwald, Taiga, Regenwald, Tundra, Hochland, Eis)
2. Klassen glätten (Gauß je Klasse, größte Wahrscheinlichkeit gewinnt) und Krümel entfernen
3. zu Polygonen machen, vereinfachen, an die echte Küste (Natural Earth 50m) beschneiden
Ausgabe: GeoJSON-Zeilen (Attribut `class`); build-landcover-vector.sh macht daraus PMTiles.
Aufruf: python3 build-landcover-vector.py [tif] [land.json] > out.geojsonl"""
import json, sys
from pathlib import Path
import numpy as np
from PIL import Image
import rasterio
from rasterio import features
from rasterio.transform import from_bounds
from scipy import ndimage
import shapely
from shapely.geometry import shape, mapping
from shapely.ops import unary_union
Image.MAX_IMAGE_PIXELS = None

HERE = Path(__file__).resolve().parent
TIF = Path(sys.argv[1] if len(sys.argv) > 1 else Path.home() / 'osm/naturalearth/NE2_HR_LC/NE2_HR_LC.tif')
LAND = Path(sys.argv[2] if len(sys.argv) > 2 else HERE / 'ne50m_land.json')
W, H = 5400, 2700
log = lambda *a: print(*a, file=sys.stderr, flush=True)

hx = lambda s: tuple(int(s[i:i + 2], 16) for i in (1, 3, 5))
# Klasse -> Quellfarben im Natural-Earth-Raster (an bekannten Orten abgelesen)
CLASSES = {
    'desert':     ['#f4f2d6', '#f4ebd2', '#f1e3c3', '#e3cfb1', '#efdcca', '#d9c9ba', '#d8c9bd', '#f2ddc8', '#d6c5ab'],
    'steppe':     ['#ebe5b9', '#e4e2b4', '#e4dbb7', '#e8eab7', '#e2dabc'],
    'savanna':    ['#d1dcb2', '#d3deb0', '#dce1b3', '#c6d6aa', '#ced9ad'],
    'temperate':  ['#b2cda7', '#b8d1a7', '#a4c39f', '#abcaa6'],
    'taiga':      ['#a2c8ae', '#a9caae', '#afc6b1'],
    'rainforest': ['#96c298', '#8ebe94', '#93c094'],
    'tundra':     ['#dbdcd1'],
    'highland':   ['#dadee0', '#dae1cf'],
    'ice':        ['#e9f1f7', '#ebf0f8'],
}
names = list(CLASSES)
anchor_rgb = np.array([hx(c) for n in names for c in CLASSES[n]], dtype=np.float32)
anchor_cls = np.array([i for i, n in enumerate(names) for _ in CLASSES[n]], dtype=np.int32)

log('lade Raster')
a = np.asarray(Image.open(TIF).convert('RGB').resize((W, H), Image.LANCZOS)).astype(np.float32)
lat = 90 - (np.arange(H) + 0.5) / H * 180
ocean = a.min(axis=2) >= 252
valid = ~ocean | ((lat < -60)[:, None] & ocean)                  # Antarktis: Eis ist fast reinweiß
cls = np.full((H, W), 255, np.uint8)
for y0 in range(0, H, 100):
    blk = a[y0:y0 + 100].reshape(-1, 3)
    d = ((blk[:, None, :] - anchor_rgb[None]) ** 2).sum(-1)
    cls[y0:y0 + 100] = anchor_cls[d.argmin(1)].reshape(-1, W)
cls[(lat < -60)[:, None] & ocean] = names.index('ice')
cls[~valid] = 255
log('klassifiziert')

# glätten: je Klasse Gauß über die Zugehörigkeit, die größte gewinnt
best = np.zeros((H, W), np.float32); lab = np.full((H, W), 255, np.uint8)
for i in range(len(names)):
    g = ndimage.gaussian_filter(((cls == i) & valid).astype(np.float32), 7.0, mode=('nearest', 'wrap'))   # sigma 7 px (~0.5 Grad): rundet die Stufen des Quellrasters
    m = g > best; best[m] = g[m]; lab[m] = i
lab[~valid] = 255
# Küstenstreifen füllen (12 Pixel), damit zwischen Klassenfläche und echter Küste keine Lücke bleibt
dist, (iy, ix) = ndimage.distance_transform_edt(lab == 255, return_indices=True)
fill = (lab == 255) & (dist <= 12)
lab[fill] = lab[iy[fill], ix[fill]]
ok = lab != 255
lab = features.sieve(lab, 80, mask=ok)                          # Krümel kleiner als 40 Pixel schlucken
ok = lab != 255
log('geglättet')

tr = from_bounds(-180, -90, 180, 90, W, H)
log('lade Küste')
land_polys = []
for f in json.load(open(LAND))['features']:
    g = shape(f['geometry'])
    land_polys.append(shapely.make_valid(g))
land = shapely.make_valid(unary_union(land_polys))
log('Küste bereit')
TOL = 0.08                                                       # Grad, ca. 5 km
for i, n in enumerate(names):
    polys = [shape(g) for g, v in features.shapes(lab, mask=(lab == i), transform=tr) if v == i]
    if not polys: continue
    u = unary_union(polys)
    u = u.simplify(TOL, preserve_topology=True)
    u = u.buffer(0.25, join_style=1).buffer(-0.5, join_style=1).buffer(0.25, join_style=1)  # erst Lücken schließen, dann Zacken abtragen: rundere Ränder
    u = shapely.intersection(u, land)
    parts = [g for g in shapely.get_parts(u) if g.geom_type in ('Polygon', 'MultiPolygon') and not g.is_empty]   # nur Flächen, keine Linien/Punkte vom Beschneiden
    flat = [q for g in parts for q in shapely.get_parts(g)]
    if not flat: continue
    u = shapely.multipolygons(flat)
    sys.stdout.write(json.dumps({'type': 'Feature', 'properties': {'class': n}, 'geometry': mapping(u)}) + '\n')
    log(n, 'fertig')
