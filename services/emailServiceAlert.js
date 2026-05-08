// Servicio de alertas internas vía Gmail SMTP.
// Se usa para notificar al admin cuando un cliente intenta facturar en un
// portal que aún no tiene handler ('fallida_temporal') o cuando ocurren
// eventos críticos del sistema (errores no recuperables, validación N=3
// completada, etc.).
//
// Coexiste con emailService.js (que sigue usando SendGrid para mandar
// constancias fiscales a portales externos). Esto es solo para alertas
// admin → admin.
//
// Config requerida en env vars:
//   GMAIL_USER           — cuenta Gmail desde la que se manda
//   GMAIL_APP_PASSWORD   — app password de 16 chars (no la contraseña normal)
//   ALERT_EMAIL_TO       — destino del alerta (opcional, default GMAIL_USER)
//
// Si falta cualquiera de las dos primeras, getTransporter() devuelve null
// y enviarAlerta() loggea sin crashear. El flujo principal (status update
// del ticket) NUNCA se bloquea por fallo de email.

const nodemailer = require('nodemailer');

function getTransporter() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });
}

/**
 * Envía un alerta interno al admin.
 * Async pero diseñado como fire-and-forget — el caller no debe esperar la
 * resolución para continuar su flujo. Si falla, loggea warning pero no throws.
 *
 * @param {Object} params
 * @param {string} params.subject - asunto del email
 * @param {string} params.body    - cuerpo en texto plano (saltos de línea = \n)
 * @param {string} [params.to]    - destinatario opcional (default ALERT_EMAIL_TO o GMAIL_USER)
 * @returns {Promise<{success:boolean, messageId?:string, error?:string}>}
 */
async function enviarAlerta({ subject, body, to } = {}) {
  if (!subject || !body) {
    console.warn('[ALERT] subject/body requeridos — alerta no enviada');
    return { success: false, error: 'subject/body requeridos' };
  }

  const transporter = getTransporter();
  if (!transporter) {
    console.warn('[ALERT] GMAIL_USER/GMAIL_APP_PASSWORD no configurados — alerta no enviada. Subject:', subject);
    return { success: false, error: 'GMAIL credentials not configured' };
  }

  const destinatario = to || process.env.ALERT_EMAIL_TO || process.env.GMAIL_USER;

  try {
    const info = await transporter.sendMail({
      from: `"FacturaYa Alerts" <${process.env.GMAIL_USER}>`,
      to: destinatario,
      subject,
      text: body
    });
    console.log(`[ALERT] enviada a ${destinatario} — messageId=${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.warn(`[ALERT] fallo SMTP — ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Helper específico para alertas de "portal en preparación".
 * Construye el subject + body según el formato acordado y llama a enviarAlerta.
 *
 * @param {Object} params
 * @param {string} params.portal             - 'walmart', 'soriana', etc.
 * @param {Object} params.solicitud          - row de la DB con datos del ticket
 * @param {number} params.contadorPendientes - tickets pendientes de este portal
 * @param {number} [params.validacionN]      - número de validaciones exitosas hechas en sandbox (0-3)
 * @returns {Promise<{success:boolean, messageId?:string, error?:string}>}
 */
async function enviarAlertaPortalEnPreparacion({ portal, solicitud, contadorPendientes = 1, validacionN = 0 } = {}) {
  if (!portal || !solicitud) {
    console.warn('[ALERT] portal/solicitud requeridos para alerta de portal en preparación');
    return { success: false, error: 'portal/solicitud requeridos' };
  }

  const portalCap = portal.charAt(0).toUpperCase() + portal.slice(1);
  const subject = `📬 ${portalCap}: ${contadorPendientes} ticket${contadorPendientes !== 1 ? 's' : ''} pendiente${contadorPendientes !== 1 ? 's' : ''} — Validación: ${validacionN}/3`;

  const body = [
    `Portal: ${portalCap}`,
    `Tickets pendientes: ${contadorPendientes}`,
    `Validación N=${validacionN}/3`,
    ``,
    `Último ticket recibido:`,
    `  ID solicitud: ${solicitud.id || '(sin id)'}`,
    `  RFC emisor: ${solicitud.rfc_emisor || '(no detectado)'}`,
    `  Establecimiento: ${solicitud.establecimiento || '(no detectado)'}`,
    `  Folio: ${solicitud.folio || '(sin folio)'}`,
    `  Fecha compra: ${solicitud.fecha_compra || '(sin fecha)'}`,
    `  Total: ${solicitud.total != null ? `$${solicitud.total}` : '(sin total)'}`,
    `  Usuario ID: ${solicitud.usuario_id || '(sin usuario)'}`,
    ``,
    `Acción requerida:`,
    `  Abrir conversación con Claude (Claude in Chrome) y hacer scout + handler nuevo.`,
    `  Cuando handler funcione 3 veces en Reino C → promover a Reino A.`,
    ``,
    `— FacturaYa Alerts (Reino C sandbox)`
  ].join('\n');

  return enviarAlerta({ subject, body });
}

module.exports = { enviarAlerta, enviarAlertaPortalEnPreparacion };
