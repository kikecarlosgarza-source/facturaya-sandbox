const { Jimp } = require('jimp');
const jsQR = require('jsqr');

async function leerQRdeImagen(base64, mimeType) {
  try {
    const buffer = Buffer.from(base64, 'base64');
    const image = await Jimp.fromBuffer(buffer);
    const { data, width, height } = image.bitmap;
    const code = jsQR(data, width, height);
    if (code) {
      console.log('[QR] URL detectada:', code.data);
      return code.data;
    }
    return null;
  } catch (e) {
    console.error('[QR] Error:', e.message);
    return null;
  }
}

module.exports = { leerQRdeImagen };
