const Tesseract = require('tesseract.js');

async function extraerCodigoFacturacion(base64Image) {
  try {
    const buffer = Buffer.from(base64Image, 'base64');
    const { data: { text } } = await Tesseract.recognize(buffer, 'spa', { logger: () => {} });
    console.log('[OCR] Texto extraido:', text.slice(0, 200));
    
    // Buscar patron "codigo de facturacion: XXXXXXXXX"
    const match = text.match(/c[oó]digo de facturaci[oó]n[:\s]+([0-9]{12,20})/i);
    if (match) {
      console.log('[OCR] Codigo encontrado:', match[1]);
      return match[1];
    }
    
    // Buscar numero largo de 15-20 digitos en el texto
    const numeros = text.match(/\b(\d{15,20})\b/g);
    if (numeros && numeros.length > 0) {
      console.log('[OCR] Numero largo encontrado:', numeros[0]);
      return numeros[0];
    }
    
    return null;
  } catch (e) {
    console.error('[OCR] Error:', e.message);
    return null;
  }
}

module.exports = { extraerCodigoFacturacion };
