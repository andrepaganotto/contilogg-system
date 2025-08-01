
---

## 📗 `README-executor.md`

```markdown
# Contilogg Executor Playwright API

API Express que consome “mapas” JSON gerados pelo Mapeador e executa:
- **Consultar** dados: retorna `true`/`false`.
- **Inserir** dados: retorna `{ ok: true }`.

Ideal para integração com n8n, cron jobs ou serviços internos.

---

## 🔍 Descrição

O **Executor** faz:

1. **Carrega** automaticamente todos os arquivos `mapa_<operação>.json` em `src/mapas`.
2. Para cada operação (`<nome>`):
   - **GET  /<nome>**  
     → chama `consultar({ url, loginInfo, dados, mapa })`  
     → retorna `{ result: true|false }`.
   - **POST /<nome>**  
     → chama `inserir({ url, loginInfo, dados, mapa })`  
     → retorna `{ ok: true }` ou erro 500.

Usuário ou orquestrador (ex.: n8n) envia JSON com:
```jsonc
{
  "url": "https://…",
  "loginInfo": { "usernameValue": "...", "passwordValue": "..." },
  "dados": { /* key→valor conforme mapa */ }
}
