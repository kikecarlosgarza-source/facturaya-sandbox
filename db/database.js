const Database = require('better-sqlite3');
const path = require('path');

// Railway tiene filesystem efímero — usar /tmp o la variable RAILWAY_VOLUME_MOUNT_PATH si existe
const DB_DIR  = process.env.DB_DIR || '/tmp';
const DB_PATH = path.join(DB_DIR, 'facturasat.db');

console.log(`[DB] Usando base de datos en: ${DB_PATH}`);

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id          TEXT PRIMARY KEY,
    email       TEXT UNIQUE NOT NULL,
    password    TEXT NOT NULL,
    nombre      TEXT,
    creado_en   TEXT DEFAULT (datetime('now')),
    activo      INTEGER DEFAULT 1
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS perfiles_fiscales (
    id          TEXT PRIMARY KEY,
    usuario_id  TEXT NOT NULL REFERENCES usuarios(id),
    rfc         TEXT NOT NULL,
    nombre      TEXT NOT NULL,
    cp          TEXT NOT NULL,
    regimen     TEXT NOT NULL DEFAULT '612',
    uso_cfdi    TEXT NOT NULL DEFAULT 'G03',
    email       TEXT NOT NULL,
    creado_en   TEXT DEFAULT (datetime('now')),
          password_portales TEXT,
          UNIQUE(usuario_id)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS solicitudes (
    id              TEXT PRIMARY KEY,
    usuario_id      TEXT NOT NULL REFERENCES usuarios(id),
    establecimiento TEXT,
    rfc_emisor      TEXT,
    folio           TEXT,
          estacion        TEXT,
                web_id          TEXT,
    fecha_compra    TEXT,
    total           REAL,
    descripcion     TEXT,
    portal_id       TEXT,
    portal_url      TEXT,
    status          TEXT DEFAULT 'pendiente',
    status_detalle  TEXT,
    ticket_img_url  TEXT,
    cfdi_uuid       TEXT,
    creado_en       TEXT DEFAULT (datetime('now')),
    actualizado_en  TEXT DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS portales_cache (
    rfc_emisor      TEXT PRIMARY KEY,
    portal_id       TEXT,
    portal_nombre   TEXT,
    portal_url      TEXT,
    requiere_cuenta INTEGER DEFAULT 0,
    ultimo_ok       TEXT
        );
      `);  

// Migraciones
try { db.exec('ALTER TABLE solicitudes ADD COLUMN estacion TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE solicitudes ADD COLUMN web_id TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE perfiles_fiscales ADD COLUMN password_portales TEXT'); } catch(e) {}
module.exports = db;
module.exports.db = db;
module.exports.uuid = require('uuid').v4;
