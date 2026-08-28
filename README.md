# FileLink Web

Transferência de arquivos **direto de um aparelho para o outro** (P2P via WebRTC),
rodando 100% no navegador. Nenhum arquivo passa por servidor: só o *handshake*
inicial usa um servidor público gratuito (broker do PeerJS).

## O que foi corrigido nesta versão

### 1. Travamento com `.pck`, `.apk`, `.bin` e outros binários

O congelamento **não era causado pelo tipo do arquivo** — era causado pelo tamanho
e pela forma como o arquivo era lido/enviado. Três causas, todas corrigidas:

| Problema | Correção |
|---|---|
| O arquivo inteiro era lido para a memória de uma vez | Agora lê em fatias de 64 KB com `file.slice().arrayBuffer()` |
| Todas as fatias eram empurradas no canal sem checar `bufferedAmount` | Backpressure real: pausa acima de 8 MB no buffer, volta abaixo de 1 MB |
| O laço de envio nunca devolvia o controle ao navegador | `await` no event loop a cada ~120 ms → a UI nunca congela |

### 2. Suporte a qualquer tipo de arquivo

- Zero dependência de MIME type. `.pck`, `.apk` e `.bin` têm `file.type` **vazio** —
  qualquer lógica baseada em MIME quebrava neles.
- A camada de serialização do PeerJS (que refragmenta e corrompe binários grandes)
  foi contornada: falamos direto com o `RTCDataChannel`, enviando controle como
  JSON (string) e conteúdo como `ArrayBuffer` puro.
- No download, o Blob é criado como `application/octet-stream`, o que força o
  download em vez de o navegador tentar abrir/renderizar o arquivo.

### 3. Excluir e cancelar

- **Na fila (não enviados):** botões **Cancelar** e **Excluir**.
- **Enviando agora:** botão **Cancelar** (avisa o outro lado, que descarta o parcial).
- **Enviados:** botão **Excluir** para sair da lista.
- **Recebidos:** botão **Excluir** (também libera o `ObjectURL` da memória).
- Ações em massa: *Cancelar tudo* e *Limpar lista*.

### 4. Listas separadas por tipo

Fila, Enviados e Recebidos são agrupados **por extensão**: APK só com APK,
BIN só com BIN, TXT só com TXT, e assim por diante. Cada grupo mostra o
selo da extensão e a contagem de arquivos. Arquivos sem extensão vão para
um grupo "SEM EXTENSÃO" no fim.

## Rodando localmente

```bash
python3 -m http.server 3000
# ou
npx serve .
```

Abra `http://localhost:3000` em dois aparelhos na mesma rede (ou em duas abas).

## Deploy na Vercel

É um site estático — sem build:

```bash
vercel --prod
```

Ou conecte diretamente este repositório na Vercel (Framework Preset = **Other**, sem comando de build).

## Como usar

1. No computador: **Iniciar no computador** → aparece um código de 6 caracteres.
2. No celular: **Conectar (celular)** → digite o código → **Conectar**.
3. Envie arquivos pelo botão ou arrastando para a área tracejada. Funciona nos
   dois sentidos ao mesmo tempo.

### 5. PC ↔ celular no 4G/5G (CGNAT)

O Peer passa a ser criado com `PEER_CONFIG.iceServers`: STUN do Google/Twilio
e TURN público `openrelay.metered.ca` (portas 80, 443 e `443?transport=tcp`,
usuário/senha `openrelayproject`). Sem TURN, NAT simétrico das operadoras
impede o furo de NAT.

- `peer.on('disconnected')` chama `peer.reconnect()` se ainda estiver desconectado.
- Estado ICE (`oniceconnectionstatechange`) aparece na tela (“Negociando rota de rede…”).
- Timeout de join: 30s (TURN demora mais que STUN).
- Erros por tipo: `peer-unavailable`, `network`, `server-error`.
- CDN reserva do PeerJS via jsDelivr se o unpkg falhar.
- O botão **Conectar** **nunca mais trava:**
  - Antes, o `setTimeout` que o reabilitava ficava **dentro** de `peer.on('open')` —
    se o serviço de sinalização não respondesse, o botão ficava desabilitado para sempre.
  - Agora há **dois** timeouts: um para o broker de sinalização (mesma mensagem clara
    se a internet cair) e outro para o TURN/ICE fechar a rota. Qualquer erro reabilita
    o botão e mostra a mensagem.
  - Se o **PeerJS não carregar** (CDN fora), o clique avisa “Não consegui iniciar o
    PeerJS — verifique a conexão e recarregue a página” em vez de travar o botão.
  - Clique duplo é ignorado (`disabled`), evitando tentativas simultâneas.

### 6. Retry (tentar de novo)

Arquivos que **falharam** (status *Erro*) ou foram **cancelados** (status
*Cancelado*) agora têm o botão **Tentar novamente**, além do **Excluir**.

- Ao clicar em **Tentar novamente**, o item volta para a **Fila** e é reenviado
  automaticamente. O lado receptor descarta qualquer parcial antigo do mesmo
  arquivo antes de recomeçar (sem duplicar itens na lista de Recebidos).
- Se a conexão estiver fechada, o botão avisa *“Reconecte os aparelhos para
  tentar de novo”* em vez de falhar silenciosamente.
- O envio agora tenta de novo sozinho em **erros transitórios** (buffer cheio)
  com retry/backoff: até 3 tentativas extras com espera crescente (250 → 600 →
  1200 ms). Só marca erro de verdade quando todas falham.
- Quando um envio falha, o outro lado é avisado (`cancel`) para descartar o
  parcial logo de cara — nada de lixo acumulado na lista de Recebidos.
- Se o canal cair no meio de um envio/recepção, o que estava em trânsito vira
  *Erro* e pode ser **Tentar novamente** depois de reconectar.
- Na tela do **host**, o botão **Novo código** regenera o código na hora — útil
  quando a negociação TURN/ICE travou e você quer tentar de novo sem voltar ao
  início.

## Limitação conhecida

O arquivo recebido é montado na memória do navegador antes de virar download.
Em celulares, arquivos acima de ~1–2 GB podem estourar a memória da aba. O envio
não tem esse limite (é lido em fatias). Para suportar arquivos gigantes na
recepção seria necessário usar a File System Access API ou StreamSaver.js.
