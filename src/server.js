// src/server.js
const express = require('express');
const path = require('path');
const fs = require('fs');

const { consultar } = require('./funcoes/consultar');
const { inserir } = require('./funcoes/inserir');

const app = express();
app.use(express.json());

// --- Carrega todos os mapas na pasta src/mapas ---
const MAP_DIR = path.join(__dirname, 'mapas');
const mapas = {};

fs.readdirSync(MAP_DIR).forEach(file => {
  const m = file.match(/^mapa_(.+)\.json$/);
  if (!m) return;
  const name = m[1]; // e.g. "consultarMotorista" ou "inserirMotorista"
  const fullPath = path.join(MAP_DIR, file);
  const content = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  mapas[name] = content;
});

// --- Cria os endpoints dinamicamente ---
Object.entries(mapas).forEach(([operation, mapa]) => {

  // GET /<operation> -> consultar
  app.get(`/${operation}`, async (req, res) => {
    const { url, loginInfo, dados } = req.body;
    try {
      const result = await consultar({ url, loginInfo, dados, mapa });
      res.json({ result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /<operation> -> inserir
  app.post(`/${operation}`, async (req, res) => {
    const { url, loginInfo, dados } = req.body;
    try {
      const result = await inserir({ url, loginInfo, dados, mapa });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

});

app.listen(3001, () => {
  console.log('API rodando em http://localhost:3001');
});
