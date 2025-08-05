// consultar.js
//
// Uso: retorna true ou false conforme presença do passo resultSelector.

const { runMapa } = require('./navegar');

/**
 * @param {Object} params – mesmo contrato do runMapa
 * @returns {Promise<boolean>}
 */
async function consultar(params) {
    const { resultFound } = await runMapa(params);
    // Se mapa não possui resultSelector retornamos false por padrão
    return !!resultFound;
}

module.exports = { consultar };
