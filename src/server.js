// src/server.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const { runMapa } = require('./navegar');

const app = express();
app.use(express.json());

// --- Carrega mapas dinamicamente -----------------------------------------
const MAP_DIR = path.join(__dirname, 'mapas');
// Estrutura: { operacao: { categoria: mapa } }
const mapas = {};

function loadMapas() {
  if (!fs.existsSync(MAP_DIR)) return;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.json')) continue;
      try {
        const json = JSON.parse(fs.readFileSync(full, 'utf8'));
        const { operacao, categoria } = json;
        if (!operacao || !categoria) {
          console.warn(`Mapa sem operacao/categoria ignorado: ${full}`);
          continue;
        }
        const op = operacao.toLowerCase();
        const cat = categoria.toLowerCase();
        if (!mapas[op]) mapas[op] = {};
        mapas[op][cat] = json;
      } catch (e) {
        console.error(`Falha ao carregar mapa ${full}:`, e.message);
      }
    }
  };

  walk(MAP_DIR);
}

loadMapas();

// --- Utilitários ----------------------------------------------------------
function getStepKeys(mapa) {
  const keys = new Set();
  if (mapa && Array.isArray(mapa.steps)) {
    for (const s of mapa.steps) {
      if (['fill', 'upload', 'select'].includes(s.action) && s.key) {
        keys.add(s.key);
      }
    }
  }
  return Array.from(keys);
}

function buildLoginInfo(req) {
  const usernameValue = req.header('login');
  const passwordValue = req.header('password');
  if (!usernameValue || !passwordValue) {
    throw new Error('Headers "login" e "password" são obrigatórios.');
  }
  return { usernameValue, passwordValue };
}

function validateKeys(required, provided, { allowPartial = false } = {}) {
  const invalid = provided.filter((k) => !required.includes(k));
  if (invalid.length) {
    throw new Error(`Chaves inválidas: ${invalid.join(', ')}`);
  }
  if (!allowPartial) {
    const missing = required.filter((k) => !provided.includes(k));
    if (missing.length) {
      throw new Error(`Chaves ausentes: ${missing.join(', ')}`);
    }
  }
}

function getMapa(op, cat) {
  return mapas[op] && mapas[op][cat];
}

// --- CONSULTAR -----------------------------------------------------------
app.get('/consultar/:categoria', async (req, res) => {
  const op = 'consultar';
  const cat = req.params.categoria.toLowerCase();
  const mapa = getMapa(op, cat);
  if (!mapa) return res.status(404).json({ error: `Mapa "${op}/${cat}" não encontrado.` });

  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Query param "url" é obrigatório.' });

  let loginInfo;
  try { loginInfo = buildLoginInfo(req); } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const required = getStepKeys(mapa);
  const queryKeys = Object.keys(req.query).filter((k) => k !== 'url');
  try { validateKeys(required, queryKeys); } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const dados = {};
  queryKeys.forEach((k) => { dados[k] = req.query[k]; });

  try {
    const { resultFound } = await runMapa({ url, loginInfo, dados, mapa });
    return res.json({ result: !!resultFound });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// --- BAIXAR --------------------------------------------------------------
app.get('/baixar/:categoria', async (req, res) => {
  const op = 'baixar';
  const cat = req.params.categoria.toLowerCase();
  const mapa = getMapa(op, cat);
  if (!mapa) return res.status(404).json({ error: `Mapa "${op}/${cat}" não encontrado.` });

  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Query param "url" é obrigatório.' });

  let loginInfo;
  try { loginInfo = buildLoginInfo(req); } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const required = getStepKeys(mapa);
  const queryKeys = Object.keys(req.query).filter((k) => !['url', 'dir', 'filename'].includes(k));
  try { validateKeys(required, queryKeys); } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const dados = {};
  queryKeys.forEach((k) => { dados[k] = req.query[k]; });

  const options = {};
  if (req.query.dir) options.downloadDir = req.query.dir;
  options.filename = req.query.filename || `${op}_${cat}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    const { downloadedPath } = await runMapa({ url, loginInfo, dados, mapa, options });
    return res.json({ downloadedPath: downloadedPath || null });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// --- CADASTRAR -----------------------------------------------------------
app.post('/cadastrar/:categoria', async (req, res) => {
  const op = 'cadastrar';
  const cat = req.params.categoria.toLowerCase();
  const mapa = getMapa(op, cat);
  if (!mapa) return res.status(404).json({ error: `Mapa "${op}/${cat}" não encontrado.` });

  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Query param "url" é obrigatório.' });

  let loginInfo;
  try { loginInfo = buildLoginInfo(req); } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const required = getStepKeys(mapa);
  const bodyKeys = Object.keys(req.body || {});
  try { validateKeys(required, bodyKeys); } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const dados = req.body || {};

  try {
    await runMapa({ url, loginInfo, dados, mapa });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// --- EDITAR --------------------------------------------------------------
app.patch('/editar/:categoria', async (req, res) => {
  const op = 'editar';
  const cat = req.params.categoria.toLowerCase();
  const mapa = getMapa(op, cat);
  if (!mapa) return res.status(404).json({ error: `Mapa "${op}/${cat}" não encontrado.` });

  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Query param "url" é obrigatório.' });

  let loginInfo;
  try { loginInfo = buildLoginInfo(req); } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const required = getStepKeys(mapa);
  const queryKeys = Object.keys(req.query).filter((k) => k !== 'url');
  const bodyKeys = Object.keys(req.body || {});
  try { validateKeys(required, queryKeys, { allowPartial: true }); } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  try { validateKeys(required, bodyKeys, { allowPartial: true }); } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const dados = {};
  queryKeys.forEach((k) => { dados[k] = req.query[k]; });
  bodyKeys.forEach((k) => { dados[k] = req.body[k]; });

  try {
    await runMapa({ url, loginInfo, dados, mapa });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(3001, () => {
  console.log('API rodando em http://localhost:3001');
});

module.exports = { app, mapas };

