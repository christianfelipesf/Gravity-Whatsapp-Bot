# Histórico (caminho próprio, sem painel)

O histórico do bot (`!investigar`, `!resumir`, logs de eventos/mídia) mora aqui:

- `src/history/store.js` — escrita e leitura no SQLite. Único lugar que
  grava histórico. Não requer o painel.
- `src/history/handler.js` — ponte do hot path (mensagens, protocolo,
  reações, mídia). Eventos e comandos usam este módulo.

## Regra anti-ligação

**NUNCA faça `require('../dashboard/dashboard')` em código novo.**

Direção permitida: `dashboard -> history` (o painel lê do banco e recebe
espelho em tempo real via `store.setMirror()`).
Direção proibida: `history -> dashboard`, `events -> dashboard`,
`commands -> dashboard` (exceto os comandos do próprio painel:
`dashboard`, `dashreset`, `dashdel`, `dashboardativar/desativar`).

Para logs e eventos, use:

```js
const store = require('../history/store');
store.writeLog(type, grp, text, name, phone, mediaInfo, { toJid, messageId, senderJid, fromMe, ... });
store.rememberGroup(jid, { subject, memberCount, ownerJid, desc });
```

Para estado de conexão (`/status`, `/qr` no Telegram), use
`src/services/principalState.js` (tem `connected`, `status`, `phone`,
`qr`) + `watchdog.getState()` — nunca `dashboard.getConnectionState()`.

## O que ainda usa o painel (remoção futura)

- `src/dashboard/*`, `src/services/dashboardAccess.js`
- Comandos: `dashboard`, `dashreset`, `dashdel`, `dashboardativar`, `dashboarddesativar`
- `src/events/dashboard-handler.js` (legado, sem importadores — manter até remover)
- Tabela `dashboard_groups` (toggle do painel por grupo) e `dashboardEnabled`
  no config — o histórico de grupo já independe disso via
  `shouldRecordHistory()` (ativo ou parcial). PV ainda usa o toggle.
- Nomes de tabelas `dashboard_*` mantidos de propósito (sem migração).
