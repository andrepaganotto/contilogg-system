// navegadorPlaywright.js
//
// Executa qualquer mapa Playwright (“consultar” ou “inserir”).
// Retorna { resultFound: boolean|null }.
//  • resultFound == true/false → só quando houver passo meta.resultSelector === true
//  • resultFound == null       → mapa não possui passo-resultado (modo “inserir”)

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

/**
 * @typedef {Object} LoginInfo
 * @property {string} usernameValue
 * @property {string} passwordValue
 *
 * @typedef {Object} MapaStep
 * @property {"fill"|"click"|"upload"|"select"|"press"|"download"} action
 * @property {string} selector
 * @property {string=} key
 * @property {{[k:string]:any}=} meta
 *
 * @typedef {Object} Mapa
 * @property {"consultar"|"inserir"=} modo
 * @property {{ username: string, password: string, submit: string }=} login
 * @property {MapaStep[]} steps
 * @property {string=} logout
 */

/**
 * Executa um mapa Playwright (modo "consultar" ou "inserir").
 *
 * @param {Object} params
 * @param {string} params.url
 * @param {LoginInfo=} params.loginInfo
 * @param {Object=} params.dados
 * @param {Mapa} params.mapa
 * @param {Object=} params.options
 * @returns {Promise<{ resultFound: (boolean|null) }>}
 */
async function runMapa({ url, loginInfo, dados = {}, mapa, options = {} }) {
    const {
        headless = false,
        timeoutMs = 15000,
        typeDelayMs = 50,
        resultWaitMs = 3000,
        downloadDir = "C:\\Users\andre\\Desktop\\arquivos_baixados"
    } = options;

    let downloadedPath = null;

    if (!url) throw new Error('"url" é obrigatório');
    if (!mapa || !Array.isArray(mapa.steps))
        throw new Error('"mapa.steps" ausente ou inválido');

    /* ---------- Valida login se existir ---------- */
    if (mapa.login) {
        const { username, password, submit } = mapa.login;
        if (!username || !password || !submit)
            throw new Error('Mapa login incompleto');
        if (!loginInfo || !loginInfo.usernameValue || !loginInfo.passwordValue)
            throw new Error('"loginInfo" ausente ou incompleto');
    }

    /* ---------- Valida dados e arquivos ---------- */
    const absentKeys = [];
    const absentFiles = [];
    for (const s of mapa.steps) {
        if (!s.selector || !s.action) throw new Error('Step inválido (sem selector/ação)');
        const needKey = ['fill', 'upload', 'select'].includes(s.action);
        if (needKey) {
            if (!s.key) throw new Error(`Step ${s.action} precisa de key (${s.selector})`);
            if (!(s.key in dados)) absentKeys.push(s.key);
            if (s.action === 'upload') {
                const list = Array.isArray(dados[s.key]) ? dados[s.key] : [dados[s.key]];
                list.forEach(f => {
                    if (typeof f !== 'string' || !fs.existsSync(f))
                        absentFiles.push({ key: s.key, path: f });
                });
            }
        }
    }
    if (absentKeys.length)
        throw new Error(`Chaves ausentes em "dados": ${[...new Set(absentKeys)].join(', ')}`);
    if (absentFiles.length) {
        const d = absentFiles.map(f => `${f.key} -> ${f.path}`).join('; ');
        throw new Error(`Arquivo(s) ausentes: ${d}`);
    }

    /* ---------- Playwright boilerplate ---------- */
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext();
    const page = await context.newPage();

    const inflight = new Map();                      // request -> timestamp
    const isXhr = r => ['xhr', 'fetch'].includes(r.resourceType?.());

    context.on('request', r => {
        if (isXhr(r)) inflight.set(r, Date.now());
    });

    context.on(['requestfinished', 'requestfailed'], r => {
        if (isXhr(r)) inflight.delete(r);
    });

    // Auxiliar para contar, ignorando “polling” >5 s
    const inflightCount = () => {
        const now = Date.now();
        for (const [req, ts] of inflight) {
            if (now - ts > 5000) inflight.delete(req);   // descarta long-poll
        }
        return inflight.size;
    };

    const quiet = async (timeoutTotal = timeoutMs) => {
        const start = Date.now();
        if (inflightCount() === 0) return;

        return new Promise((res, rej) => {
            const tick = setInterval(() => {
                if (inflightCount() === 0) { clearInterval(tick); res(); }
                else if (Date.now() - start > timeoutTotal) { clearInterval(tick); rej(new Error('timeout aguardando XHR')); }
            }, 25);
        });
    };

    const closeAll = async () => {
        try { await context.close(); } catch { }
        try { await browser.close(); } catch { }
    };

    const CLICKABLE = `
  button,[role="button"],a[href],input[type="button"],input[type="submit"],
  [role="menuitem"],[role="option"],.rf-ddm-itm,.rf-ddm-itm a,[aria-haspopup],
  [aria-expanded],[onclick],[tabindex]:not([tabindex="-1"])
  `;

    const robustClick = async ({ selector }) => {
        const loc = page.locator(selector).first();
        await loc.waitFor({ state: 'attached', timeout: timeoutMs });
        try {
            await loc.waitFor({ state: 'visible', timeout: 400 });
            await loc.click({ timeout: timeoutMs });
            return;
        } catch {/* continua */ }
        // fallback: sobe a árvore procurando algo clicável visível
        const handle = await loc.elementHandle();
        let h = handle;
        while (h) {
            const vis = await h.evaluate(el => {
                const r = el.getClientRects(); if (!r.length) return false;
                const cs = getComputedStyle(el);
                return !(cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0);
            });
            if (vis) {
                try { await h.click({ timeout: timeoutMs }); break; }
                catch {/* ignorar */ }
            }
            const parent = await h.evaluateHandle(el => el.parentElement);
            const isNull = await parent.evaluate(p => p === null);
            if (isNull) break;
            h = parent;
        }
        try { await handle.dispose(); } catch { }
    };

    /* ---------- helpers específicos ---------- */
    const typeHuman = async (loc, value, pressKey) => {
        await loc.waitFor({ state: 'visible', timeout: timeoutMs });
        await loc.click();
        try { const selAll = process.platform === 'darwin' ? 'Meta+A' : 'Control+A'; await loc.press(selAll); await loc.press('Delete'); } catch { }
        await loc.type(String(value), { delay: typeDelayMs });
        if (pressKey) await loc.press(pressKey, { timeout: timeoutMs });
    };

    let resultFound = null;

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

        /* ---------- LOGIN ---------- */
        if (mapa.login) {
            const { username, password, submit } = mapa.login;
            await page.locator(username).first().fill(loginInfo.usernameValue);
            await page.locator(password).first().fill(loginInfo.passwordValue);
            await robustClick({ selector: submit });
            await quiet();
        }

        /* ---------- PASSOS ---------- */
        for (let i = 0; i < mapa.steps.length; i++) {
            const step = mapa.steps[i];
            const { action, selector, key, meta = {} } = step;
            const loc = page.locator(selector).first();

            if (meta.resultSelector === true) {
                // Apenas testa sua existência
                try {
                    await loc.waitFor({ state: 'attached', timeout: resultWaitMs });
                    resultFound = true;
                } catch { resultFound = false; }
                break; // não executa mais nada antes do logout
            }

            switch (action) {
                case 'fill': {
                    const next = mapa.steps[i + 1];
                    const combo = next && next.action === 'press' && next.selector === selector;
                    let val = dados[key];
                    if (val === undefined) throw new Error(`dados["${key}"] ausente`);
                    if (combo) {
                        await typeHuman(loc, val, next.meta?.key || 'Enter');
                        if (next.meta?.networkTriggered) await quiet();
                        i++; // pula o press
                    } else {
                        await loc.fill(String(val));
                        if (meta.expectedUrl) {
                            try {
                                await page.waitForResponse(r => r.url().includes(meta.expectedUrl), { timeout: timeoutMs });
                            } catch { /* continua mesmo se der timeout */ }
                        }
                        if (meta.networkTriggered) await quiet();
                    }
                    break;
                }

                case 'upload': {
                    await loc.waitFor({ state: 'attached', timeout: timeoutMs });
                    const files = Array.isArray(dados[key]) ? dados[key] : [dados[key]];
                    await page.setInputFiles(selector, files);
                    break;
                }

                case 'select': {
                    await loc.waitFor({ state: 'visible', timeout: timeoutMs });
                    const v = String(dados[key]);
                    await loc.selectOption(v).catch(async () => loc.selectOption({ label: v }));
                    if (meta.expectedUrl) {
                        try {
                            await page.waitForResponse(r => r.url().includes(meta.expectedUrl), { timeout: timeoutMs });
                        } catch { /* continua mesmo se der timeout */ }
                    }
                    if (meta.networkTriggered) await quiet();
                    break;
                }

                case 'click': {
                    await robustClick({ selector });
                    if (meta.expectedUrl) {
                        try {
                            await page.waitForResponse(r => r.url().includes(meta.expectedUrl), { timeout: timeoutMs });
                        } catch { /* continua mesmo se der timeout */ }
                    }
                    if (meta.networkTriggered) await quiet();
                    break;
                }

                case 'press': {
                    await loc.waitFor({ state: 'visible', timeout: timeoutMs });
                    await loc.press(meta.key || 'Enter'); if (meta.expectedUrl) {
                        try {
                            await page.waitForResponse(r => r.url().includes(meta.expectedUrl), { timeout: timeoutMs });
                        } catch { /* continua mesmo se der timeout */ }
                    }
                    if (meta.networkTriggered) await quiet();
                    break;
                }

                case 'download': {
                    const dir = meta.downloadDir || downloadDir;
                    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }

                    // Se veio do viewer de PDF, baixe via contexto de requisição (compartilha cookies)
                    if (meta.fromPdfViewer && step.url) {
                        try {
                            const resp = await context.request.get(step.url, { timeout: timeoutMs });
                            if (!resp.ok()) throw new Error(`HTTP ${resp.status()}`);
                            const buf = await resp.body();

                            // nome sugerido ou derive da URL
                            const name = (meta.suggestedFilename && String(meta.suggestedFilename).trim())
                                || step.url.split('/').pop()
                                || 'document.pdf';

                            const saveAs = path.join(dir, name);
                            fs.writeFileSync(saveAs, buf);
                            downloadedPath = saveAs;
                            break; // <<<<< importante: NÃO clicar novamente no seletor
                        } catch (e) {
                            // fallback: se falhar o GET autenticado, tenta fluxo antigo abaixo
                            // (clicar e esperar evento "download")
                        }
                    }

                    // Fluxo padrão: aguarda evento real de download disparado pelo clique
                    const [dl] = await Promise.all([
                        page.waitForEvent('download', { timeout: timeoutMs }),
                        robustClick({ selector })
                    ]);

                    const filename = dl.suggestedFilename();
                    const saveAs = path.join(dir, filename);
                    try {
                        await dl.saveAs(saveAs);
                        downloadedPath = saveAs;
                    } catch {
                        try { downloadedPath = await dl.path(); } catch { /* mantém null */ }
                    }
                    break;
                }



                default:
                    throw new Error(`Ação não suportada: ${action}`);
            }
        }

        /* ---------- LOGOUT ---------- */
        if (mapa.logout) {
            try { await robustClick({ selector: mapa.logout }); await quiet(); } catch { }
        }

        await closeAll();
        return { resultFound, downloadedPath: (mapa.modo === 'download') ? downloadedPath : null };
    }
    catch (err) {
        await closeAll();
        throw err;
    }
}

module.exports = { runMapa };
