-- Fahrplan-Push: Abos, ihre Fahrten und was schon gesendet wurde (vorher KV: subs, sent:<id>)
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,          -- SHA-256 des Endpoints, 22 Zeichen base64url
  endpoint TEXT NOT NULL UNIQUE,
  keys TEXT NOT NULL,           -- JSON { p256dh, auth }
  tz TEXT NOT NULL,             -- Zeitzone des Geräts (Fallback für Fahrten ohne eigene)
  created_at INTEGER,
  updated_at INTEGER
);

CREATE TABLE trips (
  sub_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  trip_key TEXT NOT NULL,       -- trip.id der App
  data TEXT NOT NULL,           -- JSON der Fahrt (from, to, line, hm, days, leads, onlyDelay, tz)
  notify_at INTEGER,            -- frühester Beginn eines noch offenen Meldefensters (ms); der Cron liest nur Zeilen mit notify_at <= jetzt
  PRIMARY KEY (sub_id, trip_key)
);
CREATE INDEX trips_notify_at ON trips(notify_at);

CREATE TABLE sent (
  sub_id TEXT NOT NULL,
  key TEXT NOT NULL,            -- <trip.id>|<Jahr-Monat-Tag>|<Vorlaufminuten>
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (sub_id, key)
);
CREATE INDEX sent_sent_at ON sent(sent_at);

-- Marker des einmaligen KV-Imports (k = 'kv_import')
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
