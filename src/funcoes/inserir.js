// inserir.js
const { chromium } = require('playwright');
const fs = require('fs');

/**
 * @typedef {Object} LoginInfo
 * @property {string} usernameValue
 * @property {string} passwordValue
 *
 * @typedef {Object} MapaStep
 * @property {"fill"|"click"|"upload"|"select"} action
 * @property {string} selector
 * @property {string=} key
 * @property {{ role?: string|null, text?: string|null }=} meta
 *
 * @typedef {Object} Mapa
 * @property {{ username: string, password: string, submit: string }=} login
 * @property {MapaStep[]} steps
 */

async function inserir({ url, loginInfo, dados, mapa, options = {} }) {
    const {
        headless = false,
        timeoutMs = 15000,
        postClickWaitMs = 500, // pequeno aguardo defensivo após cliques
        typeDelayMs = 50
    } = options;

    if (!url || typeof url !== 'string') throw new Error('Parâmetro inválido: "url" é obrigatório (string).');
    if (!mapa || !Array.isArray(mapa.steps)) throw new Error('"mapa.steps" é obrigatório e deve ser um array.');

    if (mapa.login) {
        const { username, password, submit } = mapa.login;
        if (!username || !password || !submit) {
            throw new Error('Mapa de login inválido: "login.username", "login.password" e "login.submit" são obrigatórios.');
        }
        if (!loginInfo || typeof loginInfo.usernameValue !== 'string' || typeof loginInfo.passwordValue !== 'string') {
            throw new Error('"loginInfo.usernameValue" e "loginInfo.passwordValue" são obrigatórios (string).');
        }
    }

    // Validação dos steps que precisam de dados/arquivos
    const missing = [];
    const missingFiles = [];
    for (const step of mapa.steps) {
        if (!step || !step.action || !step.selector) throw new Error('Step inválido: cada step precisa de "action" e "selector".');
        const needsKey = step.action === 'fill' || step.action === 'upload' || step.action === 'select';
        if (needsKey) {
            if (!step.key) throw new Error(`Step "${step.action}" exige "key": selector=${step.selector}`);
            if (!(step.key in dados)) missing.push(step.key);
            if (step.action === 'upload') {
                const val = dados[step.key];
                const files = Array.isArray(val) ? val : [val];
                for (const f of files) {
                    if (typeof f !== 'string' || f.trim() === '' || !fs.existsSync(f)) {
                        missingFiles.push({ key: step.key, path: f });
                    }
                }
            }
        }
    }
    if (missing.length) throw new Error(`Dados ausentes no "dados": ${[...new Set(missing)].join(', ')}`);
    if (missingFiles.length) {
        const detail = missingFiles.map(m => `${m.key} -> ${m.path || '(vazio)'}`).join('; ');
        throw new Error(`Arquivo(s) de upload inexistente(s) ou inválido(s): ${detail}`);
    }

    const browser = await chromium.launch({ headless });
    const context = await browser.newContext();
    const page = await context.newPage();

    let inflightXhr = 0;
    const isXhr = r => {
        try { const t = r.resourceType(); return t === 'xhr' || t === 'fetch'; }
        catch { return false; }
    };
    context.on('request', r => { if (isXhr(r)) inflightXhr++; });
    context.on('requestfinished', r => { if (isXhr(r)) inflightXhr = Math.max(0, inflightXhr - 1); });
    context.on('requestfailed', r => { if (isXhr(r)) inflightXhr = Math.max(0, inflightXhr - 1); });

    async function waitForNetworkQuiet({ quietMs = 600, timeout = 8000 } = {}) {
        const start = Date.now();
        let lastStableAt = Date.now();
        let lastCount = inflightXhr;

        while (Date.now() - start < timeout) {
            if (inflightXhr === 0) {
                if (Date.now() - lastStableAt >= quietMs) return;
            } else if (inflightXhr !== lastCount) {
                lastStableAt = Date.now();
                lastCount = inflightXhr;
            }
            await page.waitForTimeout(50);
        }
        // timeout: segue sem travar
    }

    const closeAll = async () => {
        try { await context.close(); } catch { }
        try { await browser.close(); } catch { }
    };

    // === Helpers de espera e visibilidade ===
    async function waitAfterAction(page, { timeout }) {
        const startUrl = page.url();
        await Promise.race([
            page.waitForNavigation({ timeout }).catch(() => null),
            page.waitForURL(u => u.toString() !== startUrl, { timeout }).catch(() => null),
            page.waitForLoadState('networkidle', { timeout }).catch(() => null),
        ]);
    }

    async function isLocatorVisible(loc) {
        try { return await loc.isVisible(); }
        catch { return false; }
    }

    // === Critérios de “clicável” e “toggle de menu” no runtime ===
    const CLICKABLE_CSS = `
    button,
    [role="button"],
    a[href],
    input[type="button"],
    input[type="submit"],
    [role="menuitem"],
    [role="option"],
    .rf-ddm-itm,
    .rf-ddm-itm a,
    [aria-haspopup],
    [aria-expanded],
    [onclick],
    [tabindex]:not([tabindex="-1"])
  `;

    const SUGGEST_ITEM_SEL = '.rf-au-itm';
    const SUGGEST_LIST_SEL = '.rf-au-lst, .rf-au-itm';

    // Digita "como humano" e pressiona uma tecla (ex.: Enter) no mesmo elemento,
    // aguardando rede/lista quando necessário.
    async function typeAndMaybePress(loc, value, keyName, { waitNetwork = false, waitList = true } = {}) {
        await loc.waitFor({ state: 'visible', timeout: timeoutMs });
        await loc.click({ timeout: timeoutMs });

        // limpar conteúdo de forma "humana"
        try {
            const selectAll = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';
            await loc.press(selectAll);
            await loc.press('Delete');
        } catch { }

        await loc.type(String(value), { delay: typeDelayMs });

        // Pressionar a tecla (Enter por padrão) no próprio elemento
        await loc.press(keyName || 'Enter', { timeout: timeoutMs });

        if (waitNetwork) {
            await waitForNetworkQuiet({ quietMs: 600, timeout: 8000 }).catch(() => { });
        }

        if (waitList) {
            await Promise.race([
                page.locator(SUGGEST_LIST_SEL).first().waitFor({ state: 'visible', timeout: Math.min(timeoutMs, 5000) }),
                waitForNetworkQuiet({ quietMs: 400, timeout: 5000 })
            ]).catch(() => { });
            await page.waitForTimeout(postClickWaitMs).catch(() => { });
        }
    }


    // Sobe a partir de um ElementHandle até um ancestral clicável (sem construir seletor novo)
    async function getClickableHandleFrom(handle) {
        // Retorna o próprio se já casar
        const isCand = await handle.evaluate((el, css) => {
            try { return el.matches(css); } catch { return false; }
        }, CLICKABLE_CSS);
        if (isCand) return handle;

        // Sobe via parentElement até encontrar um candidato
        let current = handle;
        while (true) {
            const parent = await current.evaluateHandle(el => el.parentElement || null);
            const isNull = await parent.evaluate(p => p === null);
            if (isNull) break;

            const matches = await parent.evaluate((el, css) => {
                try { return el.matches(css); } catch { return false; }
            }, CLICKABLE_CSS);

            if (matches) return parent;
            await current.dispose();
            current = parent;
        }
        return handle; // fallback
    }

    // Tenta abrir dropdowns/menus subindo na árvore; faz hover/click nos toggles
    async function openMenuAncestorsFor(handle, { hoverDelay = 150, clickDelay = 120, maxHops = 6 } = {}) {
        // Coleciona até N ancestrais candidatos (de fora para dentro)
        const ancestors = [];
        let current = await handle.evaluateHandle(el => el.parentElement || null);
        for (let i = 0; i < maxHops; i++) {
            const isNull = await current.evaluate(p => p === null);
            if (isNull) break;
            const isToggle = await current.evaluate((el, css) => {
                try {
                    if (el.matches('[aria-haspopup], [aria-expanded], .rf-ddm, .rf-ddm-itm, .rf-ddm-lst, .rf-tb, .rf-tb-cntr, .rf-ddm-pos')) return true;
                    return el.matches(css);
                } catch { return false; }
            }, CLICKABLE_CSS);
            if (isToggle) {
                ancestors.push(current);
                // prepara próximo
                current = await current.evaluateHandle(el => el.parentElement || null);
            } else {
                // apenas sobe
                const next = await current.evaluateHandle(el => el.parentElement || null);
                await current.dispose();
                current = next;
            }
        }

        // Agora, do mais externo para o mais próximo do item, faz hover/click
        for (let i = ancestors.length - 1; i >= 0; i--) {
            const a = ancestors[i];
            try {
                await a.scrollIntoViewIfNeeded();
            } catch { }
            try { await a.hover(); } catch { }
            await page.waitForTimeout(hoverDelay).catch(() => { });
            // Clique leve em toggles típicos
            const shouldClick = await a.evaluate(el => {
                const expanded = el.getAttribute && el.getAttribute('aria-expanded');
                if (expanded === 'false' || expanded === null) return true;
                // heurística simples para classes de menus RichFaces
                const cls = (el.className || '') + '';
                if (/rf-ddm|rf-tb|rf-ddm-pos|rf-ddm-lst/.test(cls)) return true;
                return false;
            }).catch(() => false);
            if (shouldClick) {
                try { await a.click({ timeout: 500 }); } catch { }
                await page.waitForTimeout(clickDelay).catch(() => { });
            }
        }

        // Limpa handles
        for (const a of ancestors) { try { await a.dispose(); } catch { } }
    }

    // Click robusto:
    // - Tenta target direto.
    // - Se invisível, reancora para ancestor clicável visível; abre menus de pais se necessário.
    // - Se ainda falhar e houver meta.role/text, fallback com getByRole.
    async function robustClick({ selector, meta }) {
        const loc = page.locator(selector).first();
        await loc.waitFor({ state: 'attached', timeout: timeoutMs });

        // 1) Se já visível => clica
        if (await isLocatorVisible(loc)) {
            await loc.click({ timeout: timeoutMs });
            await page.waitForTimeout(postClickWaitMs).catch(() => { });
            return;
        }

        // 2) Reancora para ancestral clicável
        const handle = await loc.elementHandle();
        if (!handle) throw new Error(`Elemento não encontrado (selector): ${selector}`);

        let clickable = await getClickableHandleFrom(handle);
        // Se ainda invisível, tenta abrir menus nos ancestrais
        const isVisible = await clickable.evaluate(el => {
            const rects = el.getClientRects(); if (!rects || rects.length === 0) return false;
            const cs = window.getComputedStyle(el); if (!cs) return false;
            if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') === 0) return false;
            const r = rects[0]; return (r.width || 0) > 0 && (r.height || 0) > 0;
        });

        if (!isVisible) {
            await openMenuAncestorsFor(clickable).catch(() => { });
        }

        // Recheca visibilidade do próprio clickable; se visível, tenta click direto no handle
        const isVisibleNow = await clickable.evaluate(el => {
            const rects = el.getClientRects(); if (!rects || rects.length === 0) return false;
            const cs = window.getComputedStyle(el); if (!cs) return false;
            if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') === 0) return false;
            const r = rects[0]; return (r.width || 0) > 0 && (r.height || 0) > 0;
        });
        if (isVisibleNow) {
            try {
                await clickable.scrollIntoViewIfNeeded();
            } catch { }
            await clickable.click({ timeout: timeoutMs });
            await page.waitForTimeout(postClickWaitMs).catch(() => { });
            try { await clickable.dispose(); } catch { }
            try { await handle.dispose(); } catch { }
            return;
        }

        // 3) Fallback por role/text (se fornecido no mapa)
        if (meta && (meta.role || meta.text)) {
            const role = (meta.role || 'menuitem').toLowerCase();
            const name = (meta.text || '').trim();
            if (name) {
                const byRole = page.getByRole(role, { name });
                try {
                    await byRole.first().waitFor({ state: 'visible', timeout: Math.min(timeoutMs, 5000) });
                    await byRole.first().click({ timeout: timeoutMs });
                    await page.waitForTimeout(postClickWaitMs).catch(() => { });
                    try { await clickable.dispose(); } catch { }
                    try { await handle.dispose(); } catch { }
                    return;
                } catch (e) {
                    // continua para erro final abaixo
                }
            }
        }

        try { await clickable.dispose(); } catch { }
        try { await handle.dispose(); } catch { }

        throw new Error(`Não foi possível tornar o alvo clicável visível: ${selector}`);
    }

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

        // ====== LOGIN ======
        if (mapa.login) {
            const { username, password, submit } = mapa.login;
            const { usernameValue, passwordValue } = loginInfo;

            const userLoc = page.locator(username).first();
            const passLoc = page.locator(password).first();
            const btnLoc = page.locator(submit).first();

            await userLoc.waitFor({ state: 'visible', timeout: timeoutMs });
            await passLoc.waitFor({ state: 'visible', timeout: timeoutMs });

            await userLoc.fill(usernameValue);
            await passLoc.fill(passwordValue);

            // Tenta clique no botão; se não visível, usa robustClick
            let clicked = false;
            try {
                await btnLoc.waitFor({ state: 'visible', timeout: 1200 });
                await btnLoc.click({ timeout: timeoutMs });
                clicked = true;
            } catch {
                await robustClick({ selector: submit }); // reancora/abre menu se precisar
                clicked = true;
            }

            if (clicked) {
                await waitAfterAction(page, { timeout: timeoutMs });
                await page.waitForTimeout(postClickWaitMs).catch(() => { });
            }
        }
        // ====== FIM LOGIN ======

        // ====== PASSOS DO MAPA ======
        for (let i = 0; i < mapa.steps.length; i++) {
            const step = mapa.steps[i];
            const { action, selector, key, meta } = step;
            const loc = page.locator(selector).first();

            switch (action) {
                case 'fill': {
                    // Verifica se o PRÓXIMO passo é um 'press' no MESMO seletor.
                    const next = mapa.steps[i + 1];
                    const nextIsPressSameSelector = next && next.action === 'press' && next.selector === selector;

                    if (nextIsPressSameSelector) {
                        // --- Caminho ESPECIAL: digita como humano e já dispara o Enter no próprio elemento ---
                        let value = dados[key];
                        if (value === null || value === undefined) {
                            throw new Error(`Valor ausente em dados["${key}"] para fill (${selector}).`);
                        }
                        const keyName = (next.meta && next.meta.key) ? String(next.meta.key) : 'Enter';

                        await typeAndMaybePress(
                            loc,
                            value,
                            keyName,
                            {
                                // se o próximo passo (press) estava marcado como "networkTriggered", aguarde rede
                                waitNetwork: !!(next.meta && next.meta.networkTriggered),
                                // em autocomplete RichFaces, aguarde a lista aparecer (ou rede quietar)
                                waitList: true
                            }
                        );

                        // Se o fill também estava marcado como "networkTriggered", aguarde após a digitação
                        if (meta && meta.networkTriggered) {
                            await waitForNetworkQuiet({ quietMs: 600, timeout: 8000 }).catch(() => { });
                        }

                        // Importante: pulamos o próximo passo (press), pois já o executamos aqui
                        i++;
                    } else {
                        // --- Caminho RÁPIDO: manter .fill() pela performance ---
                        await loc.waitFor({ state: 'visible', timeout: timeoutMs });
                        let value = dados[key];
                        if (value === null || value === undefined) {
                            throw new Error(`Valor ausente em dados["${key}"] para fill (${selector}).`);
                        }
                        if (typeof value !== 'string') value = String(value);
                        await loc.fill(value, { timeout: timeoutMs });

                        if (meta && meta.networkTriggered) {
                            await waitForNetworkQuiet({ quietMs: 600, timeout: 8000 }).catch(() => { });
                        }
                    }
                    break;
                }

                case 'upload': {
                    await loc.waitFor({ state: 'attached', timeout: timeoutMs });
                    const value = dados[key];
                    const files = Array.isArray(value) ? value : [value];
                    await page.setInputFiles(selector, files, { timeout: timeoutMs });
                    break;
                }

                case 'select': {
                    await loc.waitFor({ state: 'visible', timeout: timeoutMs });
                    const value = dados[key];
                    await loc.selectOption(String(value), { timeout: timeoutMs }).catch(async () => {
                        await loc.selectOption({ label: String(value) }, { timeout: timeoutMs });
                    });
                    if (meta && meta.networkTriggered) {
                        await waitForNetworkQuiet({ quietMs: 600, timeout: 8000 }).catch(() => { });
                    }
                    break;
                }

                case 'click': {
                    // Se for clique em item de sugestão, garanta que a lista esteja visível antes
                    if (selector && /\.rf-au-itm/.test(selector)) {
                        await page.locator(SUGGEST_ITEM_SEL).first().waitFor({ state: 'visible', timeout: Math.min(timeoutMs, 5000) }).catch(() => { });
                    }

                    // Clique resiliente
                    await robustClick({ selector, meta });

                    if (meta && meta.networkTriggered) {
                        await waitForNetworkQuiet({ quietMs: 600, timeout: 8000 }).catch(() => { });
                    }

                    if (selector && /\.rf-au-itm/.test(selector)) {
                        await Promise.race([
                            page.locator(SUGGEST_ITEM_SEL).first().waitFor({ state: 'hidden', timeout: 3000 }),
                            waitForNetworkQuiet({ quietMs: 400, timeout: 3000 })
                        ]).catch(() => { });
                    }
                    break;
                }

                case 'press': {
                    // Obs.: em cenários onde o 'fill' anterior já cuidou do Enter (branch acima),
                    // este case será pulado porque incrementamos o índice (i++).
                    const keyName = (meta && meta.key) ? String(meta.key) : 'Enter';
                    await loc.waitFor({ state: 'visible', timeout: timeoutMs });
                    try { await loc.focus(); } catch { }

                    await loc.press(keyName, { timeout: timeoutMs });

                    if (meta && meta.networkTriggered) {
                        await waitForNetworkQuiet({ quietMs: 600, timeout: 8000 }).catch(() => { });
                    }

                    await Promise.race([
                        page.locator(SUGGEST_LIST_SEL).first().waitFor({ state: 'visible', timeout: Math.min(timeoutMs, 5000) }),
                        waitForNetworkQuiet({ quietMs: 400, timeout: 5000 })
                    ]).catch(() => { });

                    await page.waitForTimeout(postClickWaitMs).catch(() => { });
                    break;
                }

                default:
                    throw new Error(`Ação não suportada: "${action}" em selector=${selector}`);
            }
        }

        if (mapa.logout) {
            try {
                await robustClick({ selector: mapa.logout });
                await waitAfterAction(page, { timeout: Math.min(timeoutMs, 6000) }).catch(() => null);
            } catch { /* ignora falhas de logout */ }
        }

        await closeAll();
        return { ok: true };
    } catch (err) {
        await closeAll();
        throw err;
    }
}

module.exports = { inserir };
