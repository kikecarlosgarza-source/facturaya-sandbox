const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// Transport SMTP de SendGrid. Si SENDGRID_API_KEY no está seteada devolvemos
// null para que el caller pueda responder 503 limpio en lugar de crashear.
function getTransporter() {
  if (!process.env.SENDGRID_API_KEY) return null;
  return nodemailer.createTransport({
    host: 'smtp.sendgrid.net',
    port: 587,
    secure: false,
    auth: {
      user: 'apikey',
      pass: process.env.SENDGRID_API_KEY
    }
  });
}

function construirCuerpo({ perfil, establecimiento, ticket }) {
  const nombre = perfil.nombre_sat || perfil.nombre || perfil.rfc;
  return [
    `Hola, soy ${nombre}.`,
    '',
    `Solicito factura del siguiente ticket de ${establecimiento || 'su sucursal'}:`,
    `- Folio / orden: ${ticket.folio || 'no disponible'}`,
    `- Fecha de compra: ${ticket.fecha_compra || 'no disponible'}`,
    `- Total: $${ticket.total != null ? ticket.total : 'no disponible'}`,
    '',
    'Mis datos fiscales:',
    `- RFC: ${perfil.rfc}`,
    `- Nombre / razón social: ${nombre}`,
    `- Código postal: ${perfil.cp}`,
    `- Régimen fiscal: ${perfil.regimen || '612'}`,
    `- Uso de CFDI: ${perfil.uso_cfdi || 'G03'}`,
    `- Correo para envío del CFDI: ${perfil.email}`,
    '',
    'Adjunto mi Constancia de Situación Fiscal.',
    '',
    'Gracias.'
  ].join('\n');
}

async function enviarConstanciaPorEmail({ to, perfil, establecimiento, ticket, attachmentPath }) {
  const transport = getTransporter();
  if (!transport) {
    const err = new Error('email_no_configurado');
    err.code = 'EMAIL_NO_CONFIGURADO';
    throw err;
  }
  const from = process.env.SENDGRID_FROM;
  if (!from) {
    const err = new Error('SENDGRID_FROM no configurado');
    err.code = 'EMAIL_NO_CONFIGURADO';
    throw err;
  }

  const cuerpo = construirCuerpo({ perfil, establecimiento, ticket });
  const subject = `Solicitud de factura — ${perfil.rfc}`;

  const attachments = [];
  if (attachmentPath && fs.existsSync(attachmentPath)) {
    attachments.push({
      filename: 'constancia_fiscal' + path.extname(attachmentPath),
      path: attachmentPath
    });
  }

  return await transport.sendMail({ from, to, subject, text: cuerpo, attachments });
}

module.exports = { enviarConstanciaPorEmail };
