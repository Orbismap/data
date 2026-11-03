-- Kamera-Richtungen (vorher KV: ein Schlüssel "dirs" mit einem Objekt)
CREATE TABLE dirs (
  key TEXT PRIMARY KEY,         -- Kamera-Schlüssel
  value TEXT NOT NULL,          -- JSON des Eintrags { d, at, p?, pos? }
  updated_at INTEGER
);

-- Marker des einmaligen KV-Imports (k = 'kv_import')
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
