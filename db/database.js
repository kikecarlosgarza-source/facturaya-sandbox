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
// nombre_sat: nombre exacto del SAT (extraído de la Constancia de Situación Fiscal, nunca editable manualmente)
try { db.exec('ALTER TABLE perfiles_fiscales ADD COLUMN nombre_sat TEXT'); } catch(e) {}
// sistema_facturacion: portal/sistema usado para emitir la factura (facturama_shopify, wansoft, konesh, otro)
try { db.exec('ALTER TABLE solicitudes ADD COLUMN sistema_facturacion TEXT'); } catch(e) {}
// shop_name: handle de Shopify para Facturama-Shopify (ej: "bandeja-mx", "moft")
try { db.exec('ALTER TABLE solicitudes ADD COLUMN shop_name TEXT'); } catch(e) {}
// validation_error: testRunner guarda aquí el error del smoke test si falló
try { db.exec('ALTER TABLE portal_scripts ADD COLUMN validation_error TEXT'); } catch(e) {}

// Scout: cache de URLs descubiertas vía web search, cacheado por RFC o establecimiento
try { db.exec(`
  CREATE TABLE IF NOT EXISTS portal_url_cache (
    cache_key       TEXT PRIMARY KEY,
    rfc_emisor      TEXT,
    establecimiento TEXT,
    portal_url      TEXT,
    source          TEXT,
    confidence      REAL,
    searched_at     TEXT DEFAULT (datetime('now')),
    last_verified   TEXT,
    expires_at      TEXT
  )
`); } catch(e) {}

db.exec(`
  CREATE TABLE IF NOT EXISTS portal_scripts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    portal      TEXT NOT NULL,
    step        TEXT,
    patch_js    TEXT NOT NULL,
    descripcion TEXT,
    confidence  REAL,
    created_at  TEXT DEFAULT (datetime('now')),
    active      INTEGER DEFAULT 1
  );
`);

// Cuando la automatización falla, el usuario elige cómo facturar (whatsapp,
// email, portal web, no_se). Cacheamos por rfc_emisor para que la próxima vez
// que llegue ese mismo emisor podamos saltar directo al método que ya funcionó.
db.exec(`
  CREATE TABLE IF NOT EXISTS metodo_facturacion_manual (
    rfc_emisor      TEXT PRIMARY KEY,
    metodo          TEXT NOT NULL,
    actualizado_en  TEXT DEFAULT (datetime('now'))
  );
`);

// Datos de contacto del negocio (whatsapp/email) para mandar la constancia
// fiscal del usuario. Se llena por usuario la primera vez que elige WhatsApp
// o Email para un rfc_emisor; las siguientes solicitudes del mismo emisor
// reusan el cache.
db.exec(`
  CREATE TABLE IF NOT EXISTS contactos_negocio (
    rfc_emisor      TEXT PRIMARY KEY,
    whatsapp        TEXT,
    email           TEXT,
    actualizado_en  TEXT DEFAULT (datetime('now'))
  );
`);

// constancia_path: ruta absoluta al PDF/imagen de la Constancia de Situación
// Fiscal subida por el usuario. Se usa como adjunto al mandar email al negocio
// y para compartir vía WhatsApp (expo-sharing).
try { db.exec('ALTER TABLE perfiles_fiscales ADD COLUMN constancia_path TEXT'); } catch(e) {}
module.exports = db;
module.exports.db = db;
module.exports.uuid = require('uuid').v4;
