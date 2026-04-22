const axios = require('axios');
const fs = require('fs');

const img = fs.readFileSync('/tmp/constancia.jpg');
const b64 = img.toString('base64');

axios.post('https://api.anthropic.com/v1/messages', {
  model: 'claude-sonnet-4-5',
  max_tokens: 500,
  system: 'Extrae RFC, nombre, CP y regimen de esta constancia SAT. Responde solo JSON.',
  messages: [{ role: 'user', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
    { type: 'text', text: 'Extrae datos fiscales.' }
  ]}]
}, {
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01'
  }
}).then(r => console.log(JSON.stringify(r.data.content)))
  .catch(e => console.log('ERROR:', e.response?.status, JSON.stringify(e.response?.data)));
