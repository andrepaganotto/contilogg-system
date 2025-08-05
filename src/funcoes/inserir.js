// inserir.js
//
// Uso: executa um mapa (modo “inserir”) e devolve { ok: true } se não falhar.

const { runMapa } = require('./navegar');

/**
 * @param {Object} params – mesmo contrato do runMapa
 * @returns {Promise<{ ok: true }>}
 */
async function inserir(params) {
    await runMapa(params);        // se lançar erro será capturado pelo caller
    return { ok: true };
}

module.exports = { inserir };
