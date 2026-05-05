#!/usr/bin/env node
// Descubre portales de facturación nuevos en México vía Anthropic web_search,
// los agrega a targets.json como pending, y dispara el orquestador.
// Modo one-shot por default. Con --watch, repite cada hora.
const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const { spawn } = require('child_process');

const TARGETS_PATH    = path.join(__dirname, 'targets.json');
const ORQUESTADOR     = path.join(__dirname, 'orquestador.js');
const INTERVAL_MS     = 60 * 60 * 1000;   // 1h
const HEAD_TIMEOUT_MS = 5000;
const SEARCH_TIMEOUT_MS = 90000;
const ORQ_LIMIT_POR_CICLO = 5;

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

function leerTargets() {
  return JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf8'));
}

// Mismo formato que orquestador.escribirTargets — una línea por target,
// diff-friendly y legible.
function escribirTargets(data) {
  const lines = ['{'];
  for (const k of Object.keys(data).filter(k => k !== 'targets')) {
    lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(data[k])},`);
  }
  lines.push(`  "targets": [`);
  data.targets.forEach((t, i) => {
    const sep = i === data.targets.length - 1 ? '' : ',';
    lines.push(`    ${JSON.stringify(t)}${sep}`);
  });
  lines.push('  ]', '}');
  fs.writeFileSync(TARGETS_PATH, lines.join('\n') + '\n');
}

async function isAlive(url) {
  try {
    const r = await axios.head(url, {
      timeout: HEAD_TIMEOUT_MS, maxRedirects: 5, validateStatus: () => true
    });
    if (r.status < 400) return true;
    if (r.status === 405 || r.status === 403) {
      const g = await axios.get(url, {
        timeout: HEAD_TIMEOUT_MS, maxRedirects: 5,
        validateStatus: () => true, responseType: 'stream'
      });
      try { g.data?.destroy?.(); } catch {}
      return g.status < 400;
    }
    return false;
  } catch { return false; }
}

function slugId(s) {
  return String(s).toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

async function buscarPortalesNuevos(existingIds) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY no configurada');
  }

  // Mandamos solo una muestra para no inflar el prompt — Claude no necesita la
  // lista completa, solo evitar los obvios.
  const sample = Array.from(existingIds).slice(0, 80).join(', ');

  const userMsg = `Busca en internet portales de facturación electrónica (CFDI) de empresas mexicanas que NO estén en esta lista existente:
${sample}

Categorías de interés: gasolineras, retail, restaurantes, supermercados, farmacias, telecomunicaciones, hoteles, servicios al consumidor final.

Criterios:
- Solo URLs oficiales vigentes del propio negocio (NO blogs, listicles, comparativas).
- Empresas con presencia en México (cadenas o de gran volumen).
- El portal debe permitir generar CFDI a partir de un ticket/folio.

Responde SOLO con JSON sin backticks:
{"portales": [
  {"id": "slug_lower_underscore", "nombre": "Nombre Comercial", "categoria": "gasolineras|retail|restaurantes|...", "url_facturacion": "https://...", "razon": "1 línea"}
]}

Devuelve hasta 10 portales nuevos. Si no encuentras ninguno confiable: {"portales": []}.`;

  const resp = await axios.post(CLAUDE_API, {
    model: MODEL,
    max_tokens: 2048,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    messages: [{ role: 'user', content: userMsg }]
  }, {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    timeout: SEARCH_TIMEOUT_MS
  });

  const text = (resp.data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .replace(/```[\w]*\n?/g, '')
    .trim();

  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Scout: respuesta sin JSON');
  const parsed = JSON.parse(m[0]);
  return Array.isArray(parsed.portales) ? parsed.portales : [];
}

function correrOrquestador() {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [ORQUESTADOR, `--limit=${ORQ_LIMIT_POR_CICLO}`], {
      stdio: 'inherit',
      env: process.env
    });
    child.on('exit',  code => resolve(code));
    child.on('error', err  => { console.error('orquestador falló:', err.message); resolve(1); });
  });
}

async function correrCiclo() {
  console.log(`\n=== Scout ciclo ${new Date().toISOString()} ===`);
  const data = leerTargets();
  const existingIds  = new Set(data.targets.map(t => t.id));
  const existingUrls = new Set(data.targets.map(t => t.url_facturacion).filter(Boolean));

  let candidatos = [];
  try {
    candidatos = await buscarPortalesNuevos(existingIds);
  } catch (e) {
    console.error('Búsqueda falló:', e.message);
    return;
  }
  console.log(`Claude devolvió ${candidatos.length} candidato(s).`);

  let nuevos = 0;
  for (const c of candidatos) {
    const id = slugId(c.id || c.nombre || '');
    if (!id) { console.log('  skip sin id/nombre'); continue; }
    if (!c.url_facturacion || !/^https?:\/\//.test(c.url_facturacion)) {
      console.log(`  skip ${id} URL inválida`);
      continue;
    }
    if (existingIds.has(id))                  { console.log(`  skip duplicado id=${id}`);                  continue; }
    if (existingUrls.has(c.url_facturacion))  { console.log(`  skip duplicado url=${c.url_facturacion}`); continue; }
    if (!(await isAlive(c.url_facturacion))) { console.log(`  skip url muerta: ${c.url_facturacion}`);   continue; }

    data.targets.push({
      id,
      nombre: c.nombre || id,
      categoria: c.categoria || 'desconocido',
      url_facturacion: c.url_facturacion,
      rfc_emisor: null,
      prioridad: 3,
      status: 'pending',
      descubierto_por: 'scout_continuo',
      descubierto_en: new Date().toISOString().slice(0, 10)
    });
    existingIds.add(id);
    existingUrls.add(c.url_facturacion);
    nuevos++;
    console.log(`  + ${id} → ${c.url_facturacion}`);
  }

  if (nuevos > 0) {
    escribirTargets(data);
    console.log(`Agregados ${nuevos} target(s). Corriendo orquestador (limit=${ORQ_LIMIT_POR_CICLO}).`);
    await correrOrquestador();
  } else {
    console.log('Sin targets nuevos.');
  }
}

function parseArgs(argv) {
  return { watch: argv.includes('--watch') };
}

async function main() {
  const args = parseArgs(process.argv);
  await correrCiclo();
  if (!args.watch) return;

  console.log(`\nModo --watch activo. Próximo ciclo en 1h.`);
  const next = () => {
    setTimeout(async () => {
      try { await correrCiclo(); }
      catch (e) { console.error('Ciclo falló:', e.message); }
      next();
    }, INTERVAL_MS);
  };
  next();
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
