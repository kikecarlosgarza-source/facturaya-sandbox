const db = require('../db/database');

function getValidationState(portalKey) {
  const row = db.prepare('SELECT * FROM portal_validation_state WHERE portal_key = ?').get(portalKey);
  if (!row) {
    return { portalKey, n: 0, ticketsVistos: [], alertadoListoPromover: false, ultimoTicketId: null, ultimoTimbradoEn: null };
  }
  return {
    portalKey: row.portal_key,
    n: row.n,
    ticketsVistos: JSON.parse(row.tickets_vistos || '[]'),
    alertadoListoPromover: !!row.alertado_listo_promover,
    ultimoTicketId: row.ultimo_ticket_id,
    ultimoTimbradoEn: row.ultimo_timbrado_en
  };
}

function registrarTimbradoExitoso(portalKey, numeroTicket, solicitudId) {
  const state = getValidationState(portalKey);
  const ticketKey = String(numeroTicket || solicitudId || '').trim();

  if (ticketKey && state.ticketsVistos.includes(ticketKey)) {
    return { n: state.n, esDuplicado: true, llegoA3PorPrimeraVez: false, ticketsVistos: state.ticketsVistos };
  }

  const nuevoN = state.n + 1;
  const nuevosTicketsVistos = ticketKey ? [...state.ticketsVistos, ticketKey] : state.ticketsVistos;
  const llegoA3PorPrimeraVez = nuevoN >= 3 && !state.alertadoListoPromover;
  const nuevoAlertado = state.alertadoListoPromover || nuevoN >= 3;

  db.prepare(`
    INSERT INTO portal_validation_state
      (portal_key, n, tickets_vistos, alertado_listo_promover, ultimo_ticket_id, ultimo_timbrado_en)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(portal_key) DO UPDATE SET
      n = excluded.n,
      tickets_vistos = excluded.tickets_vistos,
      alertado_listo_promover = excluded.alertado_listo_promover,
      ultimo_ticket_id = excluded.ultimo_ticket_id,
      ultimo_timbrado_en = excluded.ultimo_timbrado_en
  `).run(portalKey, nuevoN, JSON.stringify(nuevosTicketsVistos), nuevoAlertado ? 1 : 0, solicitudId || null);

  return { n: nuevoN, esDuplicado: false, llegoA3PorPrimeraVez, ticketsVistos: nuevosTicketsVistos };
}

function resetValidation(portalKey) {
  return db.prepare('DELETE FROM portal_validation_state WHERE portal_key = ?').run(portalKey).changes > 0;
}

function resetAllValidation() {
  return db.prepare('DELETE FROM portal_validation_state').run().changes;
}

function listarTodos() {
  return db.prepare('SELECT * FROM portal_validation_state ORDER BY portal_key').all().map(row => ({
    portalKey: row.portal_key,
    n: row.n,
    ticketsVistos: JSON.parse(row.tickets_vistos || '[]'),
    alertadoListoPromover: !!row.alertado_listo_promover,
    ultimoTicketId: row.ultimo_ticket_id,
    ultimoTimbradoEn: row.ultimo_timbrado_en
  }));
}

module.exports = { getValidationState, registrarTimbradoExitoso, resetValidation, resetAllValidation, listarTodos };
