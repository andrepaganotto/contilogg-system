// src/server.js
const express = require('express');
const path = require('path');
const fs = require('fs');
const { runMapa } = require('./navegar');

const app = express();
app.use(express.json());

// --- Carrega todos os mapas na pasta src/mapas ---
const MAP_DIR = path.join(__dirname, 'mapas');
const mapas = {};

function loadMapas() {
  const files = fs.existsSync(MAP_DIR) ? fs.readdirSync(MAP_DIR) : [];
  files.forEach(file => {
    const m = file.match(/^mapa_(.+)\.json$/);
    if (!m) return;
    const name = m[1]; // ex.: "consulta", "inserirMotorista", "baixarPdf"
    const fullPath = path.join(MAP_DIR, file);
    try {
      const content = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      mapas[name] = content;
    } catch (e) {
      console.error(`Falha ao carregar mapa ${file}:`, e.message);
    }
  });
}
loadMapas();

// --- Util: extrai as "keys" exigidas pelos steps do mapa (fill/upload/select) ---
function getRequiredKeys(mapa) {
  const set = new Set();
  if (!mapa || !Array.isArray(mapa.steps)) return set;
  for (const s of mapa.steps) {
    if (!s || !s.action) continue;
    if ((s.action === 'fill' || s.action === 'upload' || s.action === 'select') && s.key) {
      set.add(s.key);
    }
  }
  return set;
}

// Utilitário: compõe loginInfo a partir dos headers quando necessário
function buildLoginInfo(req, mapa) {
  if (!mapa || !mapa.login) return undefined; // mapa sem login não precisa
  const usernameValue = req.header('login');
  const passwordValue = req.header('password');
  if (!usernameValue || !passwordValue) {
    throw new Error('Headers "login" e "password" são obrigatórios para este mapa.');
  }
  return { usernameValue, passwordValue };
}

// Handler compartilhado para GET (com ou sem :value)
async function handleGet(req, res) {
  const { operation, value } = req.params;
  const mapa = mapas[operation];
  if (!mapa) return res.status(404).json({ error: `Mapa "${operation}" não encontrado.` });

  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Query param "url" é obrigatório.' });

  // Regras novas: mapa GET tem 0 ou 1 key. Se 0 → sem :value; se 1 → :value é o valor dessa key.
  const requiredKeys = getRequiredKeys(mapa);
  if (requiredKeys.size > 1) {
    return res.status(400).json({ error: 'Mapa inválido para GET: mais de uma key encontrada nos steps.' });
  }

  let dados = {};
  if (requiredKeys.size === 0) {
    // Não deve haver segundo path param
    if (typeof value !== 'undefined') {
      return res.status(400).json({ error: 'Rota inválida: este mapa não aceita valor no path.' });
    }
    // dados permanece vazio
  } else {
    // Exatamente 1 key → exige :value
    const singleKey = [...requiredKeys][0];
    if (typeof value === 'undefined' || value === '') {
      return res.status(400).json({ error: `Rota inválida: este mapa exige um valor no path para a key "${singleKey}".` });
    }
    dados = { [singleKey]: value };
  }

  // options: ainda aceito ?downloadDir=... (opcional) para mapas de download
  const options = {};
  if (req.query.downloadDir) options.downloadDir = req.query.downloadDir;

  let loginInfo;
  try {
    loginInfo = buildLoginInfo(req, mapa);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  try {
    const { resultFound, downloadedPath } = await runMapa({ url, loginInfo, dados, mapa, options });

    // Respostas conforme o modo do mapa
    if (mapa.modo === 'download') {
      return res.json({ downloadedPath: downloadedPath || null });
    }
    if (mapa.modo === 'consultar') {
      return res.json({ result: !!resultFound });
    }
    if (mapa.modo === 'inserir') {
      // GET para inserir não é o comum, mas se rodar, considera sucesso se não lançou erro
      return res.json({ ok: true });
    }
    // Sem modo definido: devolve o que temos
    return res.json({ result: !!resultFound, downloadedPath: downloadedPath || null });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

// --- GET rotas (sem parâmetro opcional no padrão) ---
// Se o mapa tem 1 key → use /:operation/:value
app.get('/:operation/:value', handleGet);
// Se o mapa tem 0 keys → use /:operation
app.get('/:operation', handleGet);

// --- POST dinâmico: /:operation ---
// Ex.: POST /inserirMotorista?url=http://...  (headers login/password, body { dados: {...} })
//      POST /baixarPdf?url=http://...         (retorna { downloadedPath })
app.post('/:operation', async (req, res) => {
  const { operation } = req.params;
  const mapa = mapas[operation];
  if (!mapa) return res.status(404).json({ error: `Mapa "${operation}" não encontrado.` });

  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Query param "url" é obrigatório.' });

  let loginInfo;
  try {
    loginInfo = buildLoginInfo(req, mapa);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const bodyDados = (req.body && req.body.dados) ? req.body.dados : (req.body || {});
  const options = {};
  if (req.query.downloadDir) options.downloadDir = req.query.downloadDir;

  try {
    const { resultFound, downloadedPath } = await runMapa({ url, loginInfo, dados: bodyDados, mapa, options });

    // Respostas conforme o modo do mapa
    if (mapa.modo === 'download') {
      return res.json({ downloadedPath: downloadedPath || null });
    }
    if (mapa.modo === 'inserir') {
      return res.json({ ok: true });
    }
    if (mapa.modo === 'consultar') {
      return res.json({ result: !!resultFound });
    }
    // Sem modo definido: devolve o que temos
    return res.json({ result: !!resultFound, downloadedPath: downloadedPath || null });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.listen(3001, () => {
  console.log('API rodando em http://localhost:3001');
});
