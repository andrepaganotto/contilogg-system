// navegadorPlaywright.js
//
// Executa qualquer mapa Playwright (“consultar”, “baixar”, “cadastrar” ou “editar”).
// Retorna { resultFound: boolean|null, downloadedPath?: string }.
//  • resultFound == true/false → só quando houver passo meta.resultSelector === true
//  • resultFound == null       → mapa não possui passo-resultado

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

function ensurePdfName(filename, resUrl = '') {
    let name = filename || '';
    if (!name && resUrl) {
        const qs = new URL(resUrl, 'http://dummy').searchParams;
        const fromQS = qs.get('filename') || qs.get('fileName') || qs.get('download') || '';
        if (fromQS) name = fromQS;
    }
    if (!name) {
        const noQuery = (resUrl || '').split('?')[0];
        name = noQuery.split('/').pop() || 'document.pdf';
    }
    name = name.replace(/["']/g, '').trim();
    if (!/\.pdf$/i.test(name)) name += '.pdf';
    return name;
}

function isPdfBuffer(buf) {
    if (!buf || buf.length < 5) return false;
    try { return buf.slice(0, 5).toString() === '%PDF-'; }
    catch { return false; }
}

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
 * @property {"consultar"|"baixar"|"cadastrar"|"editar"} operacao
 * @property {{ username: string, password: string, submit: string }=} login
 * @property {MapaStep[]} steps
 * @property {string=} logout
 */

/**
 * Executa um mapa Playwright (operações "consultar", "baixar", "cadastrar" ou "editar").
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
        downloadDir = "C:\\Users\\andre\\Desktop\\arquivos_baixados",
        filename: desiredFilename,
        maxQuietMs = 1200,
        longPollCutoffMs = 2000
    } = options;

    // --- LOG / DEBUG ---------------------------------------------------------
    const debug = options.debug !== false; // default: true
    const t0 = Date.now();
    const log = (...a) => { if (debug) console.log(`[nav ${(Date.now() - t0).toFixed(0)}ms]`, ...a); };
    const warn = (...a) => console.warn(`[nav WARN ${(Date.now() - t0).toFixed(0)}ms]`, ...a);

    log('runMapa:start', { operacao: mapa.operacao, steps: mapa.steps?.length || 0, url });

    let downloadedPath = null;

    if (!url) throw new Error('"url" é obrigatório');
    if (!mapa || !Array.isArray(mapa.steps))
        throw new Error('"mapa.steps" ausente ou inválido');

    const allowOptional = mapa.operacao === 'editar';

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
            if (!(s.key in dados)) {
                if (!allowOptional) absentKeys.push(s.key);
                continue;
            }
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

    // Contexto persistente para poder aplicar flags de PDF viewer
    const userDataDir = options.userDataDir || path.join(process.cwd(), '.pw-profile');
    const context = await chromium.launchPersistentContext(userDataDir, {
        headless,
        acceptDownloads: true,
        args: [
            '--disable-pdf-viewer',            // tenta desabilitar o viewer nativo
            '--allow-running-insecure-content' // (opcional, ajuda em ambientes legados)
        ]
    });
    const page = await context.newPage();

    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);

    const inflight = new Map();                      // request -> timestamp
    const isXhr = r => ['xhr', 'fetch'].includes(r.resourceType?.());

    context.on('request', r => {
        if (isXhr(r)) inflight.set(r, Date.now());
    });

    context.on(['requestfinished', 'requestfailed'], r => {
        if (isXhr(r)) inflight.delete(r);
    });

    const inflightCount = () => {
        const now = Date.now();
        for (const [req, ts] of inflight) if (now - ts > longPollCutoffMs) inflight.delete(req);
        return inflight.size;
    };
    const quiet = async (deadline = maxQuietMs) => {
        const start = Date.now(); let lastChange = Date.now(); let lastCount = inflightCount();
        while (Date.now() - start < deadline) {
            const c = inflightCount();
            if (c === 0) return;
            if (c !== lastCount) { lastCount = c; lastChange = Date.now(); }
            if (Date.now() - lastChange >= 300) return; // estável o bastante
            await new Promise(r => setTimeout(r, 40));
        }
    };
    const closeAll = async () => {
        try { await context.close(); } catch { }
    };

    const CLICKABLE = `
  button,[role="button"],a[href],input[type="button"],input[type="submit"],
  [role="menuitem"],[role="option"],.rf-ddm-itm,.rf-ddm-itm a,[aria-haspopup],
  [aria-expanded],[onclick],[tabindex]:not([tabindex="-1"])
  `;

    const robustClick = async ({ selector }) => {
        const loc = page.locator(selector).first();
        await loc.waitFor({ state: 'attached', timeout: timeoutMs });
        try { await loc.click({ timeout: 400 }); return; } catch { }
        const h = await loc.elementHandle();
        let cur = h;
        while (cur) {
            const ok = await cur.evaluate(el => {
                const r = el.getClientRects(); if (!r.length) return false;
                const cs = getComputedStyle(el);
                return !(cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0);
            });
            if (ok) { try { await cur.click({ timeout: 600 }); break; } catch { } }
            const p = await cur.evaluateHandle(el => el.parentElement);
            if (await p.evaluate(v => v == null)) break; cur = p;
        }
        try { await h.dispose(); } catch { }
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
    let caughtError;

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

            log('step:start', { i, action: step.action, selector: step.selector, key: step.key, meta });

            if (meta.resultSelector === true) {
                // Testa este e os próximos passos marcados com resultSelector
                for (let j = i; j < mapa.steps.length; j++) {
                    const rsStep = mapa.steps[j];
                    if (rsStep.meta?.resultSelector === true) {
                        try {
                            await page.locator(rsStep.selector).first().waitFor({ state: 'attached', timeout: resultWaitMs });
                            resultFound = true;
                            break;
                        } catch {
                            resultFound = false;
                        }
                    } else {
                        break;
                    }
                }
                break; // não executa mais nada antes do logout
            }

            switch (action) {
                case 'fill': {
                    const next = mapa.steps[i + 1];
                    const combo = next && next.action === 'press' && next.selector === selector;
                    let val = dados[key];
                    if (val === undefined) {
                        if (allowOptional) {
                            if (combo) i++; // pula o press associado
                            break;
                        }
                        throw new Error(`dados["${key}"] ausente`);
                    }
                    if (combo) {
                        await typeHuman(loc, val, next.meta?.key || 'Enter');
                        await Promise.race([
                            page.locator('.rf-au-lst,.rf-au-itm').first().waitFor({ state: 'hidden', timeout: 800 }),
                            quiet(800)
                        ]).catch(() => { });
                        i++;
                    }
                    else {
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
                    if (dados[key] === undefined) {
                        if (allowOptional) break;
                        throw new Error(`dados["${key}"] ausente`);
                    }
                    await loc.waitFor({ state: 'attached', timeout: timeoutMs });
                    const files = Array.isArray(dados[key]) ? dados[key] : [dados[key]];
                    await page.setInputFiles(selector, files);
                    break;
                }

                case 'select': {
                    if (dados[key] === undefined) {
                        if (allowOptional) break;
                        throw new Error(`dados["${key}"] ausente`);
                    }
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
                    const dir = downloadDir;
                    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }

                    let downloadedOnce = false;

                    // --- Interceptação temporária para forçar "attachment" em PDFs reais ---
                    const routeHandler = async (route) => {
                        try {
                            // Evita rodar duas vezes se já baixou
                            if (downloadedOnce) return route.continue();

                            // Busca a resposta original
                            const resp = await route.fetch();
                            const headers = resp.headers();
                            const ct = (headers['content-type'] || headers['Content-Type'] || '').toLowerCase();

                            if (ct.includes('application/pdf')) {
                                const body = await resp.body();

                                // Só trata como PDF se o magic number for válido
                                if (isPdfBuffer(body)) {
                                    // Força Content-Disposition: attachment para disparar evento "download"
                                    const fulfilledHeaders = { ...headers, 'Content-Disposition': 'attachment; filename="document.pdf"' };
                                    await route.fulfill({ status: resp.status(), headers: fulfilledHeaders, body });
                                    return;
                                }
                            }

                            // Não é PDF real? segue fluxo normal
                            await route.continue();
                        } catch {
                            try { await route.continue(); } catch { /* ignora */ }
                        }
                    };

                    // Ativa o route **antes** do clique para não perder a resposta
                    await context.route('**/*', routeHandler);

                    // Algumas páginas abrem popup; vamos observar
                    const popups = [];
                    const onPage = (p) => popups.push(p);
                    context.on('page', onPage);

                    // Dispara o clique do step de download
                    await robustClick({ selector });

                    // --- Tentativa 1: download nativo na aba atual ---
                    const dlMain = await page.waitForEvent('download', { timeout: Math.min(6000, timeoutMs) }).catch(() => null);
                    if (dlMain) {
                        const filename = ensurePdfName(desiredFilename || dlMain.suggestedFilename());
                        const saveAs = path.join(dir, filename);
                        try { await dlMain.saveAs(saveAs); } catch { /* fallback abaixo */ }
                        try { downloadedPath = downloadedPath || saveAs || await dlMain.path(); } catch { }
                        downloadedOnce = !!downloadedPath;
                    }

                    // --- Tentativa 2: popups que disparem download nativo ---
                    if (!downloadedOnce) {
                        // pequena janela para popup nascer
                        await page.waitForTimeout(1000).catch(() => { });

                        for (const pop of popups) {
                            try {
                                await pop.waitForLoadState('domcontentloaded', { timeout: 7000 }).catch(() => { });

                                // Espera um possível download nativo vindo da popup
                                const dlPop = await pop.waitForEvent('download', { timeout: 3000 }).catch(() => null);
                                if (dlPop) {
                                    const filename = ensurePdfName(desiredFilename || dlPop.suggestedFilename());
                                    const saveAs = path.join(dir, filename);
                                    try { await dlPop.saveAs(saveAs); } catch { /* fallback abaixo */ }
                                    try { downloadedPath = downloadedPath || saveAs || await dlPop.path(); } catch { }
                                    downloadedOnce = !!downloadedPath;
                                    try { await pop.close(); } catch { }
                                    break;
                                }

                            } catch { /* ignora popup problemática */ }
                            finally {
                                try { await pop.close(); } catch { }
                            }
                        }
                    }

                    // --- Tentativa 3 (curta): algum download tardio após o forçar-attachment ---
                    if (!downloadedOnce) {
                        const dlLate = await page.waitForEvent('download', { timeout: Math.min(3000, timeoutMs) }).catch(() => null);
                        if (dlLate) {
                            const filename = ensurePdfName(desiredFilename || dlLate.suggestedFilename());
                            const saveAs = path.join(dir, filename);
                            try { await dlLate.saveAs(saveAs); } catch { /* ignore */ }
                            try { downloadedPath = downloadedPath || saveAs || await dlLate.path(); } catch { }
                            downloadedOnce = !!downloadedPath;
                        }
                    }

                    // Desabilita a interceptação e listener de popup antes de sair
                    try { await context.unroute('**/*', routeHandler); } catch { }
                    context.off('page', onPage);

                    // segue para os próximos passos (downloadedPath será retornado no final quando operacao === 'baixar')
                    break;
                }

                default:
                    throw new Error(`Ação não suportada: ${action}`);
            }
        }
    }
    catch (err) {
        caughtError = err;
    }
    finally {
        if (mapa.logout) {
            try { await robustClick({ selector: mapa.logout }); await quiet(); } catch { }
        }
        await closeAll();
    }
    if (caughtError) throw caughtError;
    return { resultFound, downloadedPath: (mapa.operacao === 'baixar') ? downloadedPath : null };
}

module.exports = { runMapa };