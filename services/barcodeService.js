// backend/services/barcodeService.js
// Decoder de códigos de barras desde imágenes JPEG.
// Recibe imagen base64, devuelve string con el barcode más largo de 8+ digitos numéricos, o null.

const sharp = require('sharp');
const { scanImageData } = require('@undecaf/zbar-wasm');

async function detectBarcode(imageBase64) {
  try {
    const buf = Buffer.from(imageBase64, 'base64');

    const { data, info } = await sharp(buf)
      .raw()
      .ensureAlpha()
      .toBuffer({ resolveWithObject: true });

    const imageData = {
      data: new Uint8ClampedArray(data),
      width: info.width,
      height: info.height
    };

    const symbols = await scanImageData(imageData);

    if (!symbols || symbols.length === 0) {
      console.log('[BARCODE] No barcode detected in image');
      return null;
    }

    const allDetected = symbols.map(s => ({ type: s.typeName, value: s.decode() }));
    console.log('[BARCODE] Detected ' + allDetected.length + ' barcode(s):', JSON.stringify(allDetected));

    // Filtrar candidatos: numéricos, 8+ dígitos
    const candidates = allDetected.filter(b => /^\d{8,}$/.test(b.value));

    if (candidates.length === 0) {
      console.log('[BARCODE] No numeric 8+ digit candidates found');
      return null;
    }

    // Tomar el más largo (los de ticket completo son 18-22 dígitos)
    candidates.sort((a, b) => b.value.length - a.value.length);
    const winner = candidates[0];

    console.log('[BARCODE] Selected: type=' + winner.type + ' value=' + winner.value + ' (len=' + winner.value.length + ')');
    return winner.value;

  } catch (e) {
    console.warn('[BARCODE] Detection failed (non-fatal): ' + e.message);
    return null;
  }
}

module.exports = { detectBarcode };
