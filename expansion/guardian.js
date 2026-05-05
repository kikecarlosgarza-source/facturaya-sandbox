#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { inspectPortal } = require('./inspector');
const claudeAgent = require('../services/claudeAgent');

const TARGETS_PATH  = path.join(__dirname, 'targets.json');
const SNAPSHOTS_DIR = path.join(__dirname, 'snapshots');
const ALERTAS_PATH  = path.join(__dirname, 'alertas.json');
const INTERVAL_MS   = 6 * 60 * 60 * 1000;  // 6 horas

function leerJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function escribirJSON(p, data) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (e) {}
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}
const snapshotPath = id => path.join(SNAPSHOTS_DIR, `${id}.json`);

function compararSnapshots(viejo, nuevo) {
  const cambios = [];
  if (!viejo) return cambios;  // primera vez, no hay baseline

  if (viejo.captcha !== nuevo.captcha) {
    cambios.push({ tipo: 'captcha_changed', from: viejo.captcha, to: nuevo.captcha });
  }
  if (viejo.url_encontrada !== nuevo.url_encontrada) {
    cambios.push({ tipo: 'url_changed', from: viejo.url_encontrada, to: nuevo.url_encontrada });
  }

  // Comparar campos por (tipo, name, id) — orden insensible
  const fp = c => `${c.tipo}|${c.name || ''}|${c.id || ''}`;
  const setViejo = new Set((viejo.campos || []).map(fp));
  const setNuevo = new Set((nuevo.campos || []).map(fp));
  const agregados = [...setNuevo].filter(x => !setViejo.has(x));
  const removidos = [...setViejo].filter(x => !setNuevo.has(x));
  if (agregados.length) cambios.push({ tipo: 'campos_added', items: agregados });
  if (removidos.length) cambios.push({ tipo: 'campos_removed', items: removidos });

  return cambios;
}

async function vigilarTarget(target) {
  console.log(`[${target.id}] inspeccionando...`);
  let inspeccion;
  try {
    inspeccion = await inspectPortal(target);
  } catch (e) {
    console.log(`  error en inspector: ${e.message}`);
    return { target_id: target.id, timestamp: new Date().toISOString(), cambios: [{ tipo: 'inspect_exception', error: e.message }] };
  }

  if (inspeccion.status === 'not_found') {
    return { target_id: target.id, timestamp: new Date().toISOString(), cambios: [{ tipo: 'url_rota', error: inspeccion.error }] };
  }
  if (inspeccion.status === 'error') {
    return { target_id: target.id, timestamp: new Date().toISOString(), cambios: [{ tipo: 'inspect_error', error: inspeccion.error }] };
  }

  const nuevo = {
    target_id: target.id,
    url_encontrada: inspeccion.url_encontrada,
    captcha: inspeccion.captcha,
    campos: inspeccion.campos,
    timestamp: new Date().toISOString()
  };

  const viejo = leerJSON(snapshotPath(target.id), null);
  const cambios = compararSnapshots(viejo, nuevo);

  escribirJSON(snapshotPath(target.id), nuevo);  // siempre actualizar snapshot

  if (cambios.length === 0) {
    console.log(`  sin cambios`);
    return null;
  }

  console.log(`  ${cambios.length} cambio(s): ${cambios.map(c => c.tipo).join(', ')}`);

  // Fire-and-forget: claudeAgent.analyzeAndFix con el diff (output será de calidad limitada — ver notas).
  claudeAgent.analyzeAndFix({
    portal: target.id,
    step: { action: 'guardian_change_detected' },
    error: JSON.stringify(cambios),
    html: inspeccion.html_limpio
  }).catch(e => console.warn(`  analyzeAndFix falló: ${e.message}`));

  return { target_id: target.id, timestamp: new Date().toISOString(), url: inspeccion.url_encontrada, cambios };
}

async function correrCiclo() {
  const data = leerJSON(TARGETS_PATH, null);
  if (!data) {
    console.error('No se pudo leer targets.json');
    return;
  }
  const watching = data.targets.filter(t => t.prioridad === 1 && t.url_facturacion);
  console.log(`\n=== Ciclo ${new Date().toISOString()} ===`);
  console.log(`Vigilando ${watching.length} portal(es) prio=1 con URL conocida.`);

  const alertas = [];
  for (const target of watching) {
    const alerta = await vigilarTarget(target);
    if (alerta) alertas.push(alerta);
  }

  if (alertas.length) {
    const existentes = leerJSON(ALERTAS_PATH, []);
    escribirJSON(ALERTAS_PATH, [...existentes, ...alertas]);
    console.log(`${alertas.length} alerta(s) agregada(s) a alertas.json`);
  } else {
    console.log(`Sin alertas en este ciclo.`);
  }
}

function parseArgs(argv) {
  return { watch: argv.includes('--watch') };
}

async function main() {
  const args = parseArgs(process.argv);
  await correrCiclo();

  if (!args.watch) return;

  console.log(`\nModo --watch activo. Próximo ciclo en 6h.`);
  const scheduleNext = () => {
    setTimeout(async () => {
      try { await correrCiclo(); }
      catch (e) { console.error('Ciclo falló:', e.message); }
      scheduleNext();
    }, INTERVAL_MS);
  };
  scheduleNext();
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
