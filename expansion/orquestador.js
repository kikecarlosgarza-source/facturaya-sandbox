#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { inspectPortal } = require('./inspector');
const { mapPortal } = require('./arquitecto');

const TARGETS_PATH = path.join(__dirname, 'targets.json');
const SLEEP_MS = 3000;

function parseArgs(argv) {
  const args = { limit: Infinity, id: null };
  for (const a of argv.slice(2)) {
    let m;
    if ((m = a.match(/^--limit=(\d+)$/))) { args.limit = parseInt(m[1], 10); continue; }
    if ((m = a.match(/^--id=(.+)$/)))    { args.id    = m[1]; continue; }
    if (a === '--help' || a === '-h') {
      console.log(`Uso:
  node orquestador.js                    Procesa todos los targets con status="pending"
  node orquestador.js --limit=N          Solo los primeros N (orden por prioridad)
  node orquestador.js --id=<id>          Solo un target específico (ignora filtro de status)`);
      process.exit(0);
    }
  }
  return args;
}

function leerTargets() {
  return JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf8'));
}

function escribirTargets(data) {
  // Una línea por target — diff-friendly y legible.
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

async function procesarTarget(target) {
  console.log(`\n[${target.id}] inspeccionando...`);
  const inspeccion = await inspectPortal(target);

  if (inspeccion.status === 'not_found') {
    console.log(`  not_found: ${inspeccion.error}`);
    return { newStatus: 'not_found', url: null };
  }
  if (inspeccion.status === 'error') {
    console.log(`  error: ${inspeccion.error}`);
    return { newStatus: 'error', url: null };
  }

  console.log(`  ok — url=${inspeccion.url_encontrada} tech=${inspeccion.tecnologia} captcha=${inspeccion.captcha} campos=${inspeccion.campos.length}`);
  console.log(`  arquitecto generando...`);

  let mapeo;
  try {
    mapeo = await mapPortal(inspeccion);
  } catch (e) {
    console.log(`  arquitecto falló: ${e.message}`);
    return { newStatus: 'error', url: inspeccion.url_encontrada };
  }

  if (mapeo.status === 'skipped') {
    console.log(`  arquitecto skipped: ${mapeo.razon}`);
    return { newStatus: 'error', url: inspeccion.url_encontrada };
  }

  const tipo = mapeo.config?.automation?.type;
  const newStatus = tipo === 'requires_handler' ? 'requires_handler' : 'mapped';
  console.log(`  ${newStatus} → ${mapeo.file}`);
  return { newStatus, url: inspeccion.url_encontrada };
}

async function main() {
  const args = parseArgs(process.argv);
  const data = leerTargets();

  let cola;
  if (args.id) {
    cola = data.targets.filter(t => t.id === args.id);
    if (!cola.length) {
      console.error(`No existe target con id="${args.id}"`);
      process.exit(1);
    }
  } else {
    cola = data.targets
      .filter(t => t.status === 'pending')
      .sort((a, b) => a.prioridad - b.prioridad)
      .slice(0, args.limit);
  }

  console.log(`Procesando ${cola.length} target(s).`);

  const counters = { mapped: 0, requires_handler: 0, not_found: 0, error: 0 };
  for (let i = 0; i < cola.length; i++) {
    const target = cola[i];
    const result = await procesarTarget(target);

    target.status = result.newStatus;
    if (result.url && !target.url_facturacion) target.url_facturacion = result.url;
    counters[result.newStatus]++;

    escribirTargets(data);

    if (i < cola.length - 1) await new Promise(r => setTimeout(r, SLEEP_MS));
  }

  console.log(`\n=== Resumen ===`);
  console.log(`mapped:            ${counters.mapped}`);
  console.log(`requires_handler:  ${counters.requires_handler}`);
  console.log(`not_found:         ${counters.not_found}`);
  console.log(`error:             ${counters.error}`);
  console.log(`Total procesados:  ${cola.length}`);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
