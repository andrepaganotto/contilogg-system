# Contilogg Executor Playwright API

API Express que executa fluxos do Playwright a partir de arquivos de **mapa**.

## Funcionalidades

- Carrega automaticamente todos os arquivos em `src/mapas`.  
  Cada mapa deve conter as chaves `operacao` e `categoria` para ser exposto pela API.
- Disponibiliza endpoints REST para cada par `operacao/categoria` carregado.

### Endpoints atuais

#### `GET /consultar/:categoria`

Executa o mapa de consulta e retorna se o resultado foi encontrado.

Query params:

- `url` – obrigatório.
- Outros parâmetros definidos pelo mapa (ex.: `cpf`).

Headers:

- `login`
- `password`

Resposta: `{ "result": true | false }`

#### `GET /baixar/:categoria`

Executa o mapa de download.

Query params:

- `url` – obrigatório.
- `dir` (opcional) – diretório onde salvar.
- `filename` (opcional) – nome do arquivo.
- Outros parâmetros definidos pelo mapa.

Headers: `login`, `password`.

Resposta: `{ "downloadedPath": "/caminho/do/arquivo" }`

#### `POST /cadastrar/:categoria`

Realiza cadastro conforme o mapa.

Query params: `url` obrigatório.  
Body: dados exigidos pelo mapa.  
Headers: `login`, `password`.

Resposta: `{ "ok": true }`

#### `PATCH /editar/:categoria`

Edita parcialmente um cadastro.

Query params: `url` e/ou dados (podem aparecer na query ou no body).  
Body: dados a atualizar.  
Headers: `login`, `password`.

Resposta: `{ "ok": true }`

## Estrutura de mapa

Exemplo simplificado de `src/mapas/exemplo.json`:

```json
{
  "operacao": "consultar",
  "categoria": "motorista",
  "login": {
    "username": "[name=\"formCad:nome\"]",
    "password": "[name=\"formCad:senha\"]",
    "submit": "[name=\"formCad:entrar\"]"
  },
  "steps": [
    { "action": "fill", "selector": "...", "key": "cpf" }
  ],
  "logout": "#formMenu:j_idt10"
}
```

As chaves utilizadas em ações `fill`, `upload` ou `select` determinam quais parâmetros são aceitos nas requisições.

## Executando

```bash
npm install
npm start
```

O servidor roda por padrão em `http://localhost:3001`.

