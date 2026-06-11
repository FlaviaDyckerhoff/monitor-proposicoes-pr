# 🏛️ Monitor Proposições PR — ALEPR

Monitora automaticamente o portal da Assembleia Legislativa do Paraná e envia email quando há proposições novas.

Roda **1x por dia no VPS** (8h30 BRT, dias úteis). O GitHub Actions fica como execução manual de contingência.

---

## ⚙️ Setup — Passo a Passo

### 1. Criar o repositório no GitHub

1. Acesse [github.com](https://github.com) e clique em **New repository**
2. Nome sugerido: `monitor-alep`
3. Deixe **privado** (recomendado)
4. Clique em **Create repository**

### 2. Fazer upload dos arquivos

Faça upload de todos os arquivos deste projeto para o repositório:
- `monitor.js`
- `package.json`
- `.github/workflows/monitor.yml`
- `README.md`

### 3. Configurar App Password do Gmail

> ⚠️ Não use sua senha normal do Gmail. Use um "App Password" dedicado.

1. Acesse [myaccount.google.com/security](https://myaccount.google.com/security)
2. Ative a **verificação em duas etapas** (se não estiver ativa)
3. Procure por **"Senhas de app"** (App Passwords)
4. Crie uma senha para "Mail" / "Windows Computer"
5. Copie os 16 caracteres gerados (ex: `abcd efgh ijkl mnop`)

### 4. Configurar os Secrets no GitHub

1. No repositório, vá em **Settings → Secrets and variables → Actions**
2. Clique em **New repository secret** e adicione os 3 secrets abaixo:

| Nome | Valor |
|------|-------|
| `EMAIL_REMETENTE` | seu-email@gmail.com |
| `EMAIL_SENHA` | a senha de app de 16 dígitos |
| `EMAIL_DESTINO` | email onde quer receber os alertas |

### 5. Testar manualmente

1. Vá em **Actions** no repositório
2. Clique no workflow **"Monitor Proposições PR"**
3. Clique em **"Run workflow"** → **"Run workflow"**
4. Aguarde ~2 minutos e verifique o email

---

## 📧 Exemplo de email recebido

```
Assunto: 🏛️ ALEPR: 3 nova(s) proposição(ões) — 27/03/2026

Tipo    | Número | Autor          | Data       | Ementa
--------|--------|----------------|------------|---------------------------
PL      | 123    | Dep. Fulano    | 27/03/2026 | Dispõe sobre...
REQ     | 456    | Dep. Ciclano   | 27/03/2026 | Requer informações...
```

---

## 🔧 Como funciona

1. O VPS executa `run_monitor_pr.sh` via cron.
2. O script carrega as credenciais de email de `/root/.openclaw/workspace/agents/proposicoes/.env`.
3. Consulta a API pública da ALEP com retry curto.
4. Compara com o `estado.json`.
5. Se há proposições novas → envia email.
6. Se a fonte está fora → registra falha e envia alerta com trava de repetição.

---

## ❓ Problemas comuns

**Não recebi email no primeiro run**
Normal — o primeiro run apenas salva o estado inicial. A partir do segundo run, novidades serão enviadas.

**Erro de autenticação Gmail**
Certifique-se de usar App Password (16 dígitos), não a senha normal da conta.

**Workflow não aparece em Actions**
Confirme que o arquivo `.github/workflows/monitor.yml` está na raiz do repositório com essa estrutura de pastas exata.
