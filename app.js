/* =========================================================================
   LoopSync — Vídeo + loop + música = vídeo final
   -------------------------------------------------------------------------
   - Processa tudo localmente no navegador (ffmpeg.wasm single-thread).
   - Basta escolher 1 vídeo e 1 áudio.
   - Repete o vídeo até a duração exata do áudio e corta o último loop.
   - Não aplica filtros, efeitos, textos, marcas d'água nem IA.
   ========================================================================= */

(() => {
  'use strict';

  // ----------------------------------------------------------------------
  // Estado
  // ----------------------------------------------------------------------
  const state = {
    videoFile: null, // File
    audioFile: null, // File
    videoDur: null, // segundos (via elemento de mídia)
    audioDur: null, // segundos (via elemento de mídia)
    videoName: '',
    audioName: '',
    engine: null, // instância FFmpegWASM.FFmpeg
    engineLoading: false,
    outputBlobURL: null,
    outputBlob: null,
    outputDuration: 0,
    busy: false,
  };

  const $ = (id) => document.getElementById(id);
  const screens = {
    pick: $('screen-pick'),
    processing: $('screen-processing'),
    done: $('screen-done'),
  };

  // ----------------------------------------------------------------------
  // Utilidades
  // ----------------------------------------------------------------------
  function showScreen(name) {
    Object.entries(screens).forEach(([key, el]) => {
      el.classList.toggle('is-active', key === name);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function formatDuration(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return '00:00';
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    if (h > 0) {
      const hh = String(h).padStart(2, '0');
      return `${hh}:${mm}:${ss}`;
    }
    return `${mm}:${ss}`;
  }

  function computeLoops(videoDur, audioDur) {
    if (!videoDur || !audioDur) return 0;
    if (videoDur <= 0) return 0;
    // ceil(aud / vid) com tolerância a ponto flutuante
    return Math.max(1, Math.ceil(audioDur / videoDur - 1e-9));
  }

  function toast(msg, kind = '') {
    const box = $('toasts');
    const el = document.createElement('div');
    el.className = `toast ${kind}`.trim();
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 4600);
  }

  function filenameExtension(name) {
    const dot = name.lastIndexOf('.');
    if (dot < 0) return '';
    const ext = name.slice(dot + 1).toLowerCase();
    return /^[a-z0-9]+$/.test(ext) ? ext : '';
  }

  function sanitizeFsName(name, fallback) {
    const ext = filenameExtension(name);
    const base = (name || 'input').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60);
    const safe = base || 'input';
    return ext ? `${safe}.${ext}` : `${safe}.${fallback}`;
  }

  function makeOutputName() {
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const date = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
    const time = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
    return `LoopSync_${date}_${time}.mp4`;
  }

  // ----------------------------------------------------------------------
  // Leitura segura de arquivo para o FS virtual do ffmpeg
  // ----------------------------------------------------------------------
  async function readAsUint8(file) {
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  }

  // ----------------------------------------------------------------------
  // Duração via elemento de mídia (rápido, apenas para a UI)
  // ----------------------------------------------------------------------
  function loadMediaDuration(file, kind) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const el = kind === 'video' ? document.createElement('video') : document.createElement('audio');
      el.preload = 'metadata';
      el.src = url;
      const finish = (val, err) => {
        URL.revokeObjectURL(url);
        el.removeAttribute('src');
        el.load && el.load();
        if (err) reject(err);
        else resolve(val);
      };
      el.onloadedmetadata = () => {
        if (kind === 'video' && (!el.videoWidth || !el.videoHeight)) {
          finish(null, new Error('no video track'));
          return;
        }
        const d = el.duration;
        if (isFinite(d) && d > 0) finish(d);
        else finish(null, new Error('bad duration'));
      };
      el.onerror = () => finish(null, new Error('media error'));
      // alguns navegadores demoram; timeout de segurança
      setTimeout(() => finish(null, new Error('timeout')), 8000);
    });
  }

  // ----------------------------------------------------------------------
  // Motor ffmpeg (carregado sob demanda, uma vez)
  // ----------------------------------------------------------------------
  async function ensureEngine() {
    if (state.engine && state.engine.loaded) return state.engine;
    if (state.engineLoading) {
      while (state.engineLoading) {
        await new Promise((r) => setTimeout(r, 120));
      }
      return state.engine;
    }
    if (!window.FFmpegWASM || !window.FFmpegWASM.FFmpeg) {
      throw new Error('engine-unavailable');
    }
    state.engineLoading = true;
    const FFmpeg = window.FFmpegWASM.FFmpeg;
    const engine = new FFmpeg();
    engine.on('log', ({ message }) => {
      pushLog(message);
    });
    engine.on('progress', ({ progress }) => {
      if (typeof progress === 'number') {
        const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
        $('progress-fill').style.width = pct + '%';
        $('progress-pct').textContent = pct + '%';
      }
    });
    try {
      const base = new URL('.', window.location.href).href;
      const coreURL = new URL('vendor/ffmpeg-core.js', base).href;
      const wasmURL = new URL('vendor/ffmpeg-core.wasm', base).href;
      await engine.load({ coreURL, wasmURL });
      state.engine = engine;
      return engine;
    } finally {
      state.engineLoading = false;
    }
  }

  function pushLog(message) {
    const box = $('log-box');
    if (!box) return;
    const line = document.createElement('div');
    line.textContent = message || '';
    box.appendChild(line);
    while (box.childNodes.length > 120) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  function clearLog() {
    const box = $('log-box');
    if (box) box.innerHTML = '';
  }

  // ----------------------------------------------------------------------
  // Análise de mídia via ffmpeg (durações exatas + validação de streams)
  // ----------------------------------------------------------------------
  function analyzeStream(engine, path) {
    return new Promise((resolve) => {
      const info = { duration: null, hasVideo: false, hasAudio: false };
      const onLog = ({ message }) => {
        const s = message || '';
        const md = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
        if (md && info.duration === null) {
          info.duration = (+md[1]) * 3600 + (+md[2]) * 60 + (+md[3]);
        }
        if (/Stream #\d+:\d+.*Video:/i.test(s)) info.hasVideo = true;
        if (/Stream #\d+:\d+.*Audio:/i.test(s)) info.hasAudio = true;
      };
      engine.on('log', onLog);
      const done = () => {
        engine.off('log', onLog);
        resolve(info);
      };
      // exec de apenas -i exibe os streams e retorna código não-zero (sem saída).
      // Isso é esperado; usamos apenas o log.
      engine.exec(['-i', path]).then(done, done);
      setTimeout(done, 15000);
    });
  }

  // ----------------------------------------------------------------------
  // UI: seleção de arquivos
  // ----------------------------------------------------------------------
  function updateGenerateState() {
    const ready = !!(state.videoFile && state.audioFile) && !state.busy;
    $('btn-generate').disabled = !ready;
  }

  function renderPickedFile(kind) {
    const isVideo = kind === 'video';
    const has = isVideo ? !!state.videoFile : !!state.audioFile;
    const stateEl = isVideo ? $('video-state') : $('audio-state');
    const fileView = isVideo ? $('video-file-view') : $('audio-file-view');
    const nameEl = isVideo ? $('video-name') : $('audio-name');
    const card = fileView.closest('.card');

    if (!has) {
      stateEl.textContent = isVideo ? 'Nenhum vídeo selecionado' : 'Nenhum áudio selecionado';
      fileView.hidden = true;
      card.classList.remove('has-file');
      return;
    }
    const name = isVideo ? state.videoName : state.audioName;
    const dur = isVideo ? state.videoDur : state.audioDur;
    nameEl.textContent = name;
    stateEl.textContent = `Pronto (${formatDuration(dur)})`;
    fileView.hidden = false;
    card.classList.add('has-file');

    // mostra/atualiza resumo quando os dois já estão escolhidos
    if (state.videoDur > 0 && state.audioDur > 0) {
      $('info-video').textContent = formatDuration(state.videoDur);
      $('info-audio').textContent = formatDuration(state.audioDur);
      $('info-loops').textContent = computeLoops(state.videoDur, state.audioDur);
      $('info').hidden = false;
    } else {
      $('info').hidden = true;
    }
    updateGenerateState();
  }

  function clearPickedFile(kind) {
    if (kind === 'video') {
      state.videoFile = null;
      state.videoDur = null;
      state.videoName = '';
      $('file-video').value = '';
    } else {
      state.audioFile = null;
      state.audioDur = null;
      state.audioName = '';
      $('file-audio').value = '';
    }
    renderPickedFile(kind);
  }

  async function onPickFile(kind, file) {
    if (!file) return;
    const isVideo = kind === 'video';
    try {
      const dur = await loadMediaDuration(file, kind);
      if (isVideo) {
        state.videoFile = file;
        state.videoDur = dur;
        state.videoName = file.name;
        $('file-video').value = '';
      } else {
        state.audioFile = file;
        state.audioDur = dur;
        state.audioName = file.name;
        $('file-audio').value = '';
      }
      hidePickMessage();
      renderPickedFile(kind);
    } catch (err) {
      toast(
        isVideo
          ? 'Não foi possível utilizar este arquivo. Escolha outro vídeo.'
          : 'Não foi possível utilizar este arquivo. Escolha outro áudio.',
        'err',
      );
    }
  }

  function showPickMessage(msg) {
    const el = $('pick-msg');
    el.textContent = msg;
    el.hidden = false;
  }
  function hidePickMessage() {
    $('pick-msg').hidden = true;
  }

  // ----------------------------------------------------------------------
  // Geração
  // ----------------------------------------------------------------------
  async function generate() {
    if (state.busy) return;
    if (!state.videoFile || !state.audioFile) return;

    state.busy = true;
    $('btn-generate').disabled = true;
    hidePickMessage();
    clearLog();
    $('progress-fill').style.width = '0%';
    $('progress-pct').textContent = '0%';
    $('progress-log').textContent = '';
    showScreen('processing');

    let engine;
    try {
      if (!(state.engine && state.engine.loaded)) {
        $('progress-log').textContent = 'Preparando o motor de vídeo (primeira vez)...';
      }
      engine = await ensureEngine();
      $('progress-log').textContent = '';
    } catch (err) {
      state.busy = false;
      updateGenerateState();
      showScreen('pick');
      toast(
        'Não foi possível iniciar o motor de vídeo. Recarregue a página e tente de novo.',
        'err',
      );
      return;
    }

    const videoFs = sanitizeFsName(state.videoName || 'video', 'mp4');
    const audioFs = sanitizeFsName(state.audioName || 'audio', 'mp3');
    const outFs = 'loopsync_output.mp4';

    // limpeza de execuções anteriores
    for (const p of [videoFs, audioFs, outFs]) {
      try { engine.deleteFile(p); } catch (e) { /* ok */ }
    }

    try {
      $('progress-log').textContent = 'Carregando arquivos...';
      await engine.writeFile(videoFs, await readAsUint8(state.videoFile));
      await engine.writeFile(audioFs, await readAsUint8(state.audioFile));

      $('progress-log').textContent = 'Analisando duração do vídeo e do áudio...';
      const [vinfo, ainfo] = await Promise.all([
        analyzeStream(engine, videoFs),
        analyzeStream(engine, audioFs),
      ]);

      // Validações de stream
      if (!vinfo.hasVideo) {
        throw new Error('bad-video');
      }
      if (!ainfo.hasAudio) {
        throw new Error('bad-audio');
      }

      const videoDur = vinfo.duration || state.videoDur;
      const audioDur = ainfo.duration || state.audioDur;

      if (!videoDur || !audioDur || videoDur <= 0 || audioDur <= 0) {
        throw new Error('bad-duration');
      }

      const loops = computeLoops(videoDur, audioDur);

      // título / descrição na tela
      $('progress-log').textContent = `Repetindo o vídeo (${loops}x) até o final do áudio...`;

      // Monta o comando. `-stream_loop -1` repete o vídeo infinitamente;
      // `-t audioDur` corta exatamente na duração do áudio (aplica-se também
      // ao caso "vídeo maior que áudio", onde o loop nunca é usado).
      const args = [
        '-y',
        '-stream_loop', '-1',
        '-i', videoFs,
        '-i', audioFs,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '20',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-t', String(audioDur),
        '-movflags', '+faststart',
        outFs,
      ];

      const ret = await engine.exec(args);
      if (ret !== 0) {
        throw new Error('exec-failed');
      }

      $('progress-fill').style.width = '100%';
      $('progress-pct').textContent = '100%';

      const outBytes = await engine.readFile(outFs);
      $('progress-log').textContent = 'Concluindo...';

      // Varre os temporários (privacidade)
      for (const p of [videoFs, audioFs, outFs]) {
        try { engine.deleteFile(p); } catch (e) { /* ok */ }
      }

      const blob = new Blob([outBytes], { type: 'video/mp4' });
      showResult(blob, audioDur, loops);
    } catch (err) {
      // limpeza de temporários em caso de erro
      for (const p of [videoFs, audioFs, outFs]) {
        try { engine.deleteFile(p); } catch (e) { /* ok */ }
      }
      state.busy = false;
      updateGenerateState();
      showScreen('pick');
      if (err && err.message === 'bad-video') {
        toast('Não foi possível utilizar este arquivo. Escolha outro vídeo.', 'err');
      } else if (err && err.message === 'bad-audio') {
        toast('Não foi possível utilizar este arquivo. Escolha outro áudio.', 'err');
      } else if (err && err.message === 'bad-duration') {
        toast('Não foi possível ler a duração dos arquivos. Escolha outros.', 'err');
      } else {
        toast('Não foi possível gerar o vídeo. Verifique os arquivos e tente de novo.', 'err');
      }
    }
  }

  // ----------------------------------------------------------------------
  // Resultado
  // ----------------------------------------------------------------------
  function showResult(blob, durationSeconds, loops) {
    state.outputBlob = blob;
    state.outputDuration = durationSeconds;
    if (state.outputBlobURL) URL.revokeObjectURL(state.outputBlobURL);
    state.outputBlobURL = URL.createObjectURL(blob);

    const vid = $('result-video');
    vid.src = state.outputBlobURL;
    vid.load();

    $('done-duration').textContent = `Duração: ${formatDuration(durationSeconds)}`;
    $('btn-share').disabled = !navigator.canShare || !navigator.canShare({ files: [new File([blob], makeOutputName(), { type: 'video/mp4' })] });

    state.busy = false;
    updateGenerateState();
    showScreen('done');
  }

  function downloadResult() {
    if (!state.outputBlobURL || !state.outputBlob) return;
    const a = document.createElement('a');
    const name = makeOutputName();
    a.href = state.outputBlobURL;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast('Vídeo salvo!', 'ok');
  }

  async function shareResult() {
    if (!state.outputBlob) return;
    const name = makeOutputName();
    const file = new File([state.outputBlob], name, { type: 'video/mp4' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'LoopSync' });
      } catch (e) {
        // compartilhamento cancelado pelo usuário — sem ação
      }
    } else {
      downloadResult();
    }
  }

  function resetApp() {
    if (state.outputBlobURL) URL.revokeObjectURL(state.outputBlobURL);
    state.outputBlobURL = null;
    state.outputBlob = null;
    state.outputDuration = 0;
    $('result-video').removeAttribute('src');
    clearPickedFile('video');
    clearPickedFile('audio');
    showScreen('pick');
  }

  // ----------------------------------------------------------------------
  // Eventos
  // ----------------------------------------------------------------------
  function bindEvents() {
    $('btn-pick-video').addEventListener('click', () => $('file-video').click());
    $('btn-pick-audio').addEventListener('click', () => $('file-audio').click());

    $('btn-clear-video').addEventListener('click', () => clearPickedFile('video'));
    $('btn-clear-audio').addEventListener('click', () => clearPickedFile('audio'));

    $('file-video').addEventListener('change', (e) => onPickFile('video', e.target.files[0]));
    $('file-audio').addEventListener('change', (e) => onPickFile('audio', e.target.files[0]));

    $('btn-generate').addEventListener('click', generate);

    $('btn-save').addEventListener('click', downloadResult);
    $('btn-share').addEventListener('click', shareResult);
    $('btn-again').addEventListener('click', resetApp);
  }

  // ----------------------------------------------------------------------
  // Início
  // ----------------------------------------------------------------------
  function init() {
    bindEvents();
    updateGenerateState();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
