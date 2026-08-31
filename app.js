/* =========================================================================

   FileLink Web — transferência P2P de arquivos pelo navegador (WebRTC)

   -------------------------------------------------------------------------

   Correções principais desta versão:

   1. NUNCA carrega o arquivo inteiro na memória. Lê em fatias de 64 KB com

      file.slice().arrayBuffer(). Era isso que travava .apk/.pck grandes.

   2. Respeita backpressure do RTCDataChannel (bufferedAmount). Sem isso o

      canal enche, o navegador bloqueia e a aba congela.

   3. Cede o controle ao event loop entre as fatias -> a UI nunca trava.

   4. Zero dependência de MIME type. .pck, .apk, .bin e afins têm file.type

      vazio; tudo é tratado como binário puro (application/octet-stream).

   5. Fala direto com o RTCDataChannel, sem a camada de serialização do

      PeerJS (que refragmenta e corrompe binários grandes).

   6. TURN dinâmico via conta própria do Metered (serverless /api/turn-

      credentials), com fallback pro relay público caso a API falhe.

   ========================================================================= */

(() => {

  'use strict';



  // ----------------------------------------------------------------- config

  const CHUNK_SIZE = 64 * 1024; // 64 KB por fatia

  const BUFFER_HIGH = 8 * 1024 * 1024; // pausa de enviar acima disso

  const BUFFER_LOW = 1 * 1024 * 1024; // volta a enviar abaixo disso

  const ID_PREFIX = 'filelink-web-';

  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem I,O,0,1

  const JOIN_TIMEOUT_MS = 30000;

  const MAX_SEND_RETRIES = 3;

  const RETRY_BACKOFF_MS = [250, 600, 1200];



  // Fallback caso /api/turn-credentials falhe (mantém o app funcionando

  // mesmo se a conta do Metered estiver indisponível).

  const FALLBACK_ICE_SERVERS = [

    { urls: 'stun:stun.l.google.com:19302' },

    { urls: 'stun:stun.cloudflare.com:3478' },

    { urls: 'stun:global.stun.twilio.com:3478' },

    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },

    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },

    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },

  ];



  let cachedIceServers = null;

  let iceServersPromise = null;



  /**

   * Busca credenciais TURN dedicadas (conta Metered) via serverless function

   * da Vercel. A API Key nunca aparece no navegador — fica só no servidor.

   * Se a chamada falhar, cai no fallback público (Openrelay + STUN).

   */

  function fetchIceServers() {

    if (cachedIceServers) return Promise.resolve(cachedIceServers);

    if (iceServersPromise) return iceServersPromise;



    iceServersPromise = fetch('/api/turn-credentials')

      .then((r) => {

        if (!r.ok) throw new Error(`status ${r.status}`);

        return r.json();

      })

      .then((data) => {

        if (!Array.isArray(data.iceServers) || data.iceServers.length === 0) {

          throw new Error('resposta vazia');

        }

        cachedIceServers = data.iceServers;

        return cachedIceServers;

      })

      .catch((err) => {

        console.warn('Não consegui buscar TURN do Metered, usando fallback público.', err);

        cachedIceServers = FALLBACK_ICE_SERVERS;

        return cachedIceServers;

      });



    return iceServersPromise;

  }



  function peerErrorMessage(err) {

    const type = (err && err.type) || '';

    if (type === 'peer-unavailable') {

      return 'Código não encontrado (peer-unavailable). Confira no computador.';

    }

    if (type === 'network') {

      return 'Falha de rede (network). Verifique a conexão e tente de novo.';

    }

    if (type === 'server-error') {

      return 'O servidor de sinalização falhou (server-error). Tente novamente.';

    }

    if (type === 'unavailable-id') {

      return 'Este código já está em uso. Gerando outro...';

    }

    return `Erro: ${type || (err && err.message) || err}`;

  }



  // ------------------------------------------------------------------ state

  const state = {

    peer: null,

    conn: null,

    dc: null,

    connected: false,

    outgoing: [],

    incoming: [],

    receiving: null,

    pumping: false,

    seq: 0,

  };



  const uid = () => `f${Date.now().toString(36)}${(state.seq++).toString(36)}`;



  // --------------------------------------------------------------- utilidades

  const $ = (id) => document.getElementById(id);



  function fmtBytes(n) {

    if (!Number.isFinite(n) || n < 0) return '—';

    if (n < 1024) return `${n} B`;

    const u = ['KB', 'MB', 'GB', 'TB'];

    let i = -1;

    do {

      n /= 1024;

      i++;

    } while (n >= 1024 && i < u.length - 1);

    return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;

  }



  function extOf(name) {

    const m = /\.([A-Za-z0-9_+-]{1,12})$/.exec(name || '');

    return m ? m[1].toUpperCase() : 'SEM EXTENSÃO';

  }



  function escapeHtml(s) {

    return String(s).replace(

      /[&<>"']/g,

      (c) =>

        ({

          '&': '&amp;',

          '<': '&lt;',

          '>': '&gt;',

          '"': '&quot;',

          "'": '&#39;',

        })[c],

    );

  }



  function randomCode(n = 6) {

    const a = new Uint32Array(n);

    crypto.getRandomValues(a);

    let s = '';

    for (let i = 0; i < n; i++) s += ALPHABET[a[i] % ALPHABET.length];

    return s;

  }



  function toast(msg, kind = '') {

    const box = $('toasts');

    const el = document.createElement('div');

    el.className = `toast ${kind}`;

    el.textContent = msg;

    box.appendChild(el);

    setTimeout(() => {

      el.style.opacity = '0';

      el.style.transition = 'opacity .25s';

      setTimeout(() => el.remove(), 260);

    }, 3200);

  }



  function showScreen(id) {

    document

      .querySelectorAll('.screen')

      .forEach((s) => s.classList.toggle('is-active', s.id === id));

  }



  // =======================================================================

  // RENDER

  // =======================================================================

  function groupByExt(items) {

    const map = new Map();

    for (const it of items) {

      if (!map.has(it.ext)) map.set(it.ext, []);

      map.get(it.ext).push(it);

    }

    return [...map.entries()].sort((a, b) => {

      if (a[0] === 'SEM EXTENSÃO') return 1;

      if (b[0] === 'SEM EXTENSÃO') return -1;

      return a[0].localeCompare(b[0], 'pt-BR');

    });

  }



  const STATUS_LABEL = {

    pending: 'Na fila',

    sending: 'Enviando',

    sent: 'Enviado',

    cancelled: 'Cancelado',

    error: 'Erro',

  };



  function groupHtml(ext, items, rowFn) {

    return `

    <div class="group">

      <div class="group-head">

        <span class="chip">${escapeHtml(ext)}</span>

        <span class="n">${items.length} ${items.length === 1 ? 'arquivo' : 'arquivos'}</span>

      </div>

      ${items.map(rowFn).join('')}

    </div>`;

  }



  function outgoingRow(it) {

    const pct = it.size ? Math.min(100, (it.sent / it.size) * 100) : 0;

    let acts = '';

    if (it.status === 'pending') {

      acts = `

        <button class="btn btn-tiny btn-warn-ghost" data-act="cancel" data-id="${it.id}">Cancelar</button>

        <button class="btn btn-tiny btn-danger-ghost" data-act="remove" data-id="${it.id}">Excluir</button>`;

    } else if (it.status === 'sending') {

      acts = `<button class="btn btn-tiny btn-warn-ghost" data-act="cancel" data-id="${it.id}">Cancelar</button>`;

    } else if (it.status === 'error' || it.status === 'cancelled') {

      acts = `

        <button class="btn btn-tiny btn-ghost" data-act="retry" data-id="${it.id}">Tentar novamente</button>

        <button class="btn btn-tiny btn-danger-ghost" data-act="remove" data-id="${it.id}">Excluir</button>`;

    } else {

      acts = `<button class="btn btn-tiny btn-danger-ghost" data-act="remove" data-id="${it.id}">Excluir</button>`;

    }



    const showBar = it.status === 'sending' || it.status === 'pending';

    return `

    <div class="item">

      <div class="item-main">

        <div class="item-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</div>

        <div class="item-meta">

          <span class="tag ${it.status}">${STATUS_LABEL[it.status]}</span>

          <span>${fmtBytes(it.size)}</span>

          ${it.status === 'sending' ? `<span>${pct.toFixed(0)}%</span>` : ''}

        </div>

        ${showBar ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}

      </div>

      <div class="item-acts">${acts}</div>

    </div>`;

  }



  function incomingRow(it) {

    const done = it.status === 'done';

    const pct = it.size ? Math.min(100, (it.recv / it.size) * 100) : 0;

    return `

    <div class="item">

      <div class="item-main">

        <div class="item-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</div>

        <div class="item-meta">

          <span>${fmtBytes(it.size)}</span>

          ${done ? '' : `<span>${pct.toFixed(0)}%</span>`}

        </div>

        ${done ? '' : `<div class="bar"><i style="width:${pct}%"></i></div>`}

      </div>

      <div class="item-acts">

        ${done ? `<a class="dl" href="${it.url}" download="${escapeHtml(it.name)}">Baixar</a>` : ''}

        <button class="btn btn-tiny btn-danger-ghost" data-act="remove-recv" data-id="${it.id}">Excluir</button>

      </div>

    </div>`;

  }



  let renderQueued = false;

  function render() {

    if (renderQueued) return;

    renderQueued = true;

    requestAnimationFrame(() => {

      renderQueued = false;

      doRender();

    });

  }



  function doRender() {

    const queue = state.outgoing.filter((i) => i.status !== 'sent');

    const sent = state.outgoing.filter((i) => i.status === 'sent');



    $('panel-queue').hidden = queue.length === 0;

    $('queue-count').textContent = String(queue.length);

    $('queue-groups').innerHTML = groupByExt(queue)

      .map(([e, items]) => groupHtml(e, items, outgoingRow))

      .join('');



    $('panel-sent').hidden = sent.length === 0;

    $('sent-count').textContent = String(sent.length);

    $('sent-groups').innerHTML = groupByExt(sent)

      .map(([e, items]) => groupHtml(e, items, outgoingRow))

      .join('');



    $('panel-recv').hidden = state.incoming.length === 0;

    $('recv-count').textContent = String(state.incoming.length);

    $('recv-groups').innerHTML = groupByExt(state.incoming)

      .map(([e, items]) => groupHtml(e, items, incomingRow))

      .join('');

  }



  // =======================================================================

  // TRANSPORTE

  // =======================================================================

  const sendCtl = (obj) => {

    if (state.dc && state.dc.readyState === 'open')

      state.dc.send(JSON.stringify(obj));

  };



  function waitForDrain() {

    const dc = state.dc;

    if (!dc || dc.bufferedAmount < BUFFER_HIGH) return Promise.resolve();

    return new Promise((resolve) => {

      const tick = () => {

        if (!state.dc || state.dc.readyState !== 'open') return resolve();

        if (state.dc.bufferedAmount <= BUFFER_LOW) return resolve();

        setTimeout(tick, 25);

      };

      setTimeout(tick, 25);

    });

  }



  const nextTick = () => new Promise((r) => setTimeout(r, 0));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));



  async function sendOne(item) {

    const file = item.file;

    item.status = 'sending';

    item.sent = 0;

    render();



    sendCtl({ t: 'start', id: item.id, name: file.name, size: file.size, ext: item.ext });



    let offset = 0;

    let lastPaint = 0;



    while (offset < file.size) {

      if (item.cancelRequested) {

        sendCtl({ t: 'cancel', id: item.id });

        item.status = 'cancelled';

        render();

        return;

      }



      if (!state.dc || state.dc.readyState !== 'open') {

        item.status = 'error';

        render();

        return;

      }



      await waitForDrain();



      const end = Math.min(offset + CHUNK_SIZE, file.size);

      let buf;

      try {

        buf = await file.slice(offset, end).arrayBuffer();

      } catch (err) {

        console.error('Falha ao ler fatia do arquivo', err);

        sendCtl({ t: 'cancel', id: item.id });

        item.status = 'error';

        render();

        toast(`Erro ao ler "${file.name}"`, 'err');

        return;

      }



      let sent = false;

      for (let attempt = 0; attempt <= MAX_SEND_RETRIES; attempt++) {

        try {

          state.dc.send(buf);

          sent = true;

          break;

        } catch (err) {

          console.warn(`send falhou (tentativa ${attempt + 1}/${MAX_SEND_RETRIES + 1})`, err);

          await waitForDrain();

          if (attempt < MAX_SEND_RETRIES) {

            await sleep(RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]);

          }

        }

      }



      if (!sent) {

        sendCtl({ t: 'cancel', id: item.id });

        item.status = 'error';

        render();

        toast(`Falha ao enviar "${file.name}"`, 'err');

        return;

      }



      offset = end;

      item.sent = offset;



      const now = performance.now();

      if (now - lastPaint > 120) {

        lastPaint = now;

        render();

        await nextTick();

      }

    }



    sendCtl({ t: 'end', id: item.id });

    item.sent = file.size;

    item.status = 'sent';

    render();

  }



  async function pump() {

    if (state.pumping) return;

    state.pumping = true;

    try {

      while (true) {

        const next = state.outgoing.find((i) => i.status === 'pending');

        if (!next) break;

        if (next.cancelRequested) {

          next.status = 'cancelled';

          render();

          continue;

        }

        await sendOne(next);

      }

    } finally {

      state.pumping = false;

    }

  }



  // ---------------------------------------------------------------- recepção

  function handleControl(msg) {

    switch (msg.t) {

      case 'start': {

        state.incoming = state.incoming.filter(

          (i) => i.status !== 'receiving' || i.id !== msg.id,

        );

        state.receiving = {

          id: msg.id,

          name: msg.name,

          size: msg.size,

          ext: msg.ext || extOf(msg.name),

          parts: [],

          recv: 0,

          status: 'receiving',

        };

        state.incoming.unshift(state.receiving);

        render();

        break;

      }

      case 'end': {

        const r = state.receiving;

        if (!r || r.id !== msg.id) return;

        const blob = new Blob(r.parts, { type: 'application/octet-stream' });

        r.url = URL.createObjectURL(blob);

        r.parts = [];

        r.status = 'done';

        r.recv = r.size;

        state.receiving = null;

        render();

        toast(`Recebido: ${r.name}`, 'ok');

        break;

      }

      case 'cancel': {

        const r = state.receiving;

        if (r && r.id === msg.id) {

          state.incoming = state.incoming.filter((i) => i !== r);

          state.receiving = null;

          render();

          toast(`Envio de "${r.name}" foi cancelado`, '');

        }

        break;

      }

    }

  }



  function handleBinary(data) {

    const r = state.receiving;

    if (!r) return;

    r.parts.push(data);

    r.recv += data.byteLength ?? data.size ?? 0;

    render();

  }



  function attachChannel(dc) {

    state.dc = dc;

    dc.binaryType = 'arraybuffer';

    dc.onmessage = (ev) => {

      const d = ev.data;

      if (typeof d === 'string') {

        try {

          handleControl(JSON.parse(d));

        } catch (e) {

          console.warn('controle inválido', e);

        }

      } else {

        handleBinary(d);

      }

    };

  }



  // =======================================================================

  // CONEXÃO

  // =======================================================================



  /** Agora assíncrona: espera as credenciais TURN antes de criar o Peer. */

  async function newPeer(id) {

    const iceServers = await fetchIceServers();

    const peer = new Peer(id, { debug: 1, config: { iceServers } });



    peer.on('disconnected', () => {

      if (peer.destroyed || !peer.disconnected) return;

      try {

        peer.reconnect();

      } catch (e) {

        console.warn('peer.reconnect falhou', e);

      }

    });



    return peer;

  }



  function setIceUi(text, kind) {

    const host = $('host-status');

    const join = $('join-status');

    const connEl = $('conn-status');

    const ice = $('ice-status');

    if (ice) {

      ice.textContent = text;

      ice.className = 'status' + (kind ? ' ' + kind : '');

    }

    const apply = (el) => {

      if (!el) return;

      el.textContent = text;

      el.className = 'status' + (kind ? ' ' + kind : '');

    };

    if (!state.connected) {

      apply(host);

      apply(join);

    }

    if (connEl && state.connected) {

      /* keep connected label; ice-status shows path */

    }

  }



  function watchIce(conn) {

    const pc = conn.peerConnection;

    if (!pc) return;

    const apply = () => {

      const st = pc.iceConnectionState;

      if (st === 'checking' || st === 'new') {

        setIceUi('Negociando rota de rede...', '');

      } else if (st === 'connected' || st === 'completed') {

        setIceUi('Rota de rede estabelecida.', 'ok');

      } else if (st === 'disconnected') {

        setIceUi('Conexão ICE instável...', '');

      } else if (st === 'failed') {

        setIceUi('Falha de NAT/ICE. TURN pode não ter sido alcançado.', 'err');

      } else if (st === 'closed') {

        setIceUi('Conexão ICE encerrada.', 'err');

      } else {

        setIceUi('ICE: ' + st, '');

      }

    };

    pc.oniceconnectionstatechange = apply;

    apply();

  }



  function wireConnection(conn) {

    state.conn = conn;

    watchIce(conn);



    conn.on('open', () => {

      state.connected = true;

      attachChannel(conn.dataChannel);

      $('conn-status').textContent = 'Conectado';

      $('conn-status').className = 'status ok';

      showScreen('screen-transfer');

      toast('Conectado!', 'ok');

      render();

    });



    conn.on('close', () => {

      state.connected = false;

      $('conn-status').textContent = 'Conexão encerrada';

      $('conn-status').className = 'status err';

      state.outgoing.forEach((i) => {

        if (i.status === 'sending') i.status = 'error';

      });

      state.incoming.forEach((i) => {

        if (i.status === 'receiving') i.status = 'error';

      });

      state.receiving = null;

      render();

      toast('Conexão encerrada', 'err');

    });



    conn.on('error', (err) => {

      console.error('conn error', err);

      toast('Erro na conexão', 'err');

    });

  }



  async function startHost() {

    const code = randomCode();

    $('host-code').textContent = code;

    $('host-status').textContent = 'Aguardando conexão do celular...';

    showScreen('screen-host');



    if (state.peer) state.peer.destroy();



    const peer = await newPeer(ID_PREFIX + code);

    state.peer = peer;



    peer.on('error', (err) => {

      console.error(err);

      if (err.type === 'unavailable-id') {

        startHost();

        return;

      }

      $('host-status').textContent = peerErrorMessage(err);

      $('host-status').className = 'status err';

    });



    peer.on('connection', (conn) => {

      if (state.conn && state.connected) {

        conn.close();

        return;

      }

      wireConnection(conn);

    });

  }



  function startJoin() {

    $('join-status').textContent = '';

    $('join-status').className = 'status';

    $('join-code').value = '';

    showScreen('screen-join');

    setTimeout(() => $('join-code').focus(), 120);

  }



  async function doConnect() {

    const code = ($('join-code').value || '').trim().toUpperCase();

    if (code.length < 4) {

      $('join-status').textContent = 'Digite o código completo.';

      $('join-status').className = 'status err';

      return;

    }

    if ($('btn-connect').disabled) return;



    $('btn-connect').disabled = true;

    $('join-status').textContent = 'Conectando...';

    $('join-status').className = 'status';



    let openTimer = 0;
    let joinTimer = 0;
    const fail = (msg) => {
      clearTimeout(openTimer);
      clearTimeout(joinTimer);
      $('btn-connect').disabled = false;
      $('join-status').textContent = msg;
      $('join-status').className = 'status err';
    };

    if (state.peer) state.peer.destroy();
    let peer;
    try {
      peer = await newPeer(undefined);
    } catch (err) {
      console.error('Não consegui criar o Peer.', err);
      $('btn-connect').disabled = false;
      $('join-status').textContent =
        'Não consegui iniciar o PeerJS. Verifique a conexão e recarregue a página.';
      $('join-status').className = 'status err';
      return;
    }
    state.peer = peer;

    let opened = false;
    // 1) timeout: conectando ao servidor de sinalização (broker)
    openTimer = setTimeout(() => {
      if (!opened && !state.connected) {
        fail('Não consegui conectar ao servidor de sinalização. Verifique a internet.');
      }
    }, JOIN_TIMEOUT_MS);

    peer.on('open', () => {
      opened = true;
      clearTimeout(openTimer);

      const conn = peer.connect(ID_PREFIX + code, {
        reliable: true,
        serialization: 'none', // nós cuidamos do binário
      });
      wireConnection(conn);

      // 2) timeout: TURN/ICE fechando a rota com o outro aparelho
      joinTimer = setTimeout(() => {
        if (!state.connected) {
          fail('Tempo esgotado (30s). TURN em 4G/5G pode demorar — tente de novo.');
        }
      }, JOIN_TIMEOUT_MS);

      conn.on('open', () => {
        clearTimeout(joinTimer);
      });
    });

    peer.on('error', (err) => {
      console.error(err);
      fail(peerErrorMessage(err));
    });
  }

  // =======================================================================
  //  ARQUIVOS
  // =======================================================================

  function addFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    for (const f of files) {
      state.outgoing.push({
        id: uid(),
        file: f,
        name: f.name,
        size: f.size,
        ext: extOf(f.name), // extensão, nunca MIME
        sent: 0,
        status: 'pending',
        cancelRequested: false,
        attempts: 0,
      });
    }
    render();
    toast(
      `${files.length} ${files.length === 1 ? 'arquivo adicionado' : 'arquivos adicionados'}`,
    );
    pump();
  }

  function onAction(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const { act, id } = btn.dataset;

    if (act === 'cancel') {
      const it = state.outgoing.find((i) => i.id === id);
      if (!it) return;
      it.cancelRequested = true;
      if (it.status === 'pending') it.status = 'cancelled';
      render();
      return;
    }

    if (act === 'retry') {
      const it = state.outgoing.find((i) => i.id === id);
      if (!it || it.status === 'sending') return;
      if (!state.connected || !state.dc || state.dc.readyState !== 'open') {
        toast('Reconecte os aparelhos para tentar de novo', 'err');
        return;
      }
      it.status = 'pending';
      it.sent = 0;
      it.cancelRequested = false;
      it.attempts = (it.attempts || 0) + 1;
      render();
      pump();
      return;
    }

    if (act === 'remove') {
      const it = state.outgoing.find((i) => i.id === id);
      if (!it) return;
      if (it.status === 'sending') it.cancelRequested = true;
      state.outgoing = state.outgoing.filter((i) => i.id !== id);
      render();
      return;
    }

    if (act === 'remove-recv') {
      const it = state.incoming.find((i) => i.id === id);
      if (!it) return;
      if (it.url) URL.revokeObjectURL(it.url);
      if (state.receiving === it) state.receiving = null;
      state.incoming = state.incoming.filter((i) => i.id !== id);
      render();
    }
  }

  // =======================================================================
  //  BOOT
  // =======================================================================

  function init() {
    $('btn-host').addEventListener('click', startHost);
    $('btn-join').addEventListener('click', startJoin);
    $('btn-connect').addEventListener('click', doConnect);

    $('join-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doConnect();
    });

    $('btn-copy-code').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText($('host-code').textContent.trim());
        toast('Código copiado', 'ok');
      } catch {
        toast('Não consegui copiar', 'err');
      }
    });

    $('btn-new-code').addEventListener('click', () => {
      // se a conexão travou/falhou, o host pode gerar um código novo e tentar de novo
      toast('Gerando novo código...', '');
      startHost();
    });

    document.querySelectorAll('[data-back]').forEach((b) =>
      b.addEventListener('click', () => {
        showScreen('screen-home');
      }),
    );

    $('btn-pick').addEventListener('click', () => $('file-input').click());
    $('file-input').addEventListener('change', (e) => {
      addFiles(e.target.files);
      e.target.value = ''; // permite reenviar o mesmo arquivo
    });

    // drag & drop
    const dz = $('dropzone');
    ['dragenter', 'dragover'].forEach((ev) =>
      dz.addEventListener(ev, (e) => {
        e.preventDefault();
        dz.classList.add('hot');
      }),
    );
    ['dragleave', 'drop'].forEach((ev) =>
      dz.addEventListener(ev, (e) => {
        e.preventDefault();
        dz.classList.remove('hot');
      }),
    );
    dz.addEventListener('drop', (e) => {
      if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    // ações das listas (delegação)
    $('screen-transfer').addEventListener('click', onAction);

    $('btn-clear-queue').addEventListener('click', () => {
      state.outgoing.forEach((i) => {
        if (i.status === 'sending' || i.status === 'pending')
          i.cancelRequested = true;
      });
      state.outgoing = state.outgoing.filter((i) => i.status === 'sent');
      render();
    });

    $('btn-clear-sent').addEventListener('click', () => {
      state.outgoing = state.outgoing.filter((i) => i.status !== 'sent');
      render();
    });

    $('btn-clear-recv').addEventListener('click', () => {
      state.incoming.forEach((i) => i.url && URL.revokeObjectURL(i.url));
      state.incoming = state.incoming.filter((i) => i.status !== 'done');
      render();
    });

    render();
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', init);
  else init();
})();
