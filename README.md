# LoopSync

**Vídeo + música. Automaticamente.**

O LoopSync junta **1 vídeo** e **1 áudio** num único vídeo:

> PEGAR UM VÍDEO + PEGAR UM ÁUDIO → REPETIR/CORTAR O VÍDEO ATÉ FICAR COM A
> MESMA DURAÇÃO DO ÁUDIO → EXPORTAR O RESULTADO.

O vídeo é repetido (em loop) até cobrir toda a duração do áudio. Quando chega
no final, o último loop é cortado no ponto exato, para que o vídeo final termine
**exatamente** na duração do áudio.

- Se o vídeo for **maior que o áudio**, usa só os primeiros segundos do vídeo.
- Se tiverem a mesma duração, não repete.
- Se o vídeo for menor, repete o quanto for preciso.

O **audio do vídeo original é descartado** — a trilha sonora é apenas o arquivo
de áudio escolhido pelo usuário.

Não há filtros, efeitos, transições, zoom, texto, marca d'água, IA, nem
"montagens inteligentes". A única operação sobre o vídeo é:
**REPETIR → REPETIR → CORTAR O FINAL QUANDO NECESSÁRIO.**

## Privacidade

Todo o processamento acontece **no próprio aparelho** (navegador), usando
`ffmpeg.wasm`. Nenhum vídeo ou música é enviado para servidores. Não é preciso
criar conta nem entrar. Os arquivos temporários são descartados ao final de
cada geração.

## Como usar

1. Escolher **1 vídeo**.
2. Escolher **1 áudio / música**.
3. Tocar em **Gerar vídeo**.
4. Salvar ou compartilhar o resultado (`.mp4`).

O resultado é salvo com um nome como `LoopSync_2026-08-31_125000.mp4`.

## Rodando localmente

É um site estático (sem build):

```bash
python3 -m http.server 8899
# ou
npx serve .
```

Abra `http://localhost:8899`.

O motor de vídeo (`ffmpeg.wasm`) fica em `vendor/`:

- `vendor/ffmpeg.js` e `vendor/814.ffmpeg.js` — wrapper (com o worker).
- `vendor/ffmpeg-core.js` e `vendor/ffmpeg-core.wasm` — núcleo (single-thread).

Eles são carregados do **mesmo domínio** (não dependem de CDN), então o app
funciona offline/em qualquer ambiente.

## Deploy na Vercel

Site estático, sem comando de build (Framework Preset **Other**). Basta publicar
o repositório. Os arquivos `vendor/*` são servidos como assets estáticos.

## Cenários testados

| Vídeo | Áudio | Loops | Duração final |
|---|---|---|---|
| 15 s | 2 min | 8 | 2:00 |
| 30 s | 2 min 15 s | 4 + 15 s do 5º | 2:15 |
| 1 min | 20 s | 1 (corta) | 0:20 |
| 30 s | 2 min | 4 | 2:00 |
| 30 s | 30 s | 1 | 0:30 |
