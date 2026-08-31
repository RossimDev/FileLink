/* =========================================================================
   FileLink Web — função serverless (Vercel) que entrega credenciais TURN
   -------------------------------------------------------------------------
   O app.js busca TURN dinâmico neste endpoint em vez de usar o relay
   público (openrelay). A chave da conta fica só no servidor: por padrão usa
   a chave embutida abaixo; se a variável de ambiente METERED_API_KEY for
   configurada na Vercel, ela tem precedência. A chave nunca vai para o
   cliente — o navegador só recebe as credenciais TURN temporárias.

   Formato da resposta (o que o app.js espera em data.iceServers):
   {
     "iceServers": [
       { "urls": "stun:..." },
       { "urls": "turn:...", "username": "...", "credential": "..." }
     ]
   }
   ========================================================================= */

export default async function handler(req, res) {
  // Só aceita GET
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Método não permitido' });
  }

  // Chave da conta Metered embutida como fallback para o deploy funcionar
  // sem configuração extra. Se a env var METERED_API_KEY estiver definida
  // na Vercel, ela tem PRECEDÊNCIA sobre a chave embutida. O mesmo vale
  // para METERED_DOMAIN (ex.: "meuapp.metered.live") sobre o domínio padrão.
  const EMBEDDED_METERED_API_KEY = 'VxDhLw8hPPzfTtsIDvoAomFMQlAPLU5OVbEiuu7lrqFx0kQu';

  const apiKey = process.env.METERED_API_KEY || EMBEDDED_METERED_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'METERED_API_KEY não configurada no ambiente.' });
  }

  // URLs candidatas, na ordem: domínio do app (formato atual da Metered) e
  // endpoint legado. A primeira que responder com credenciais válidas vence.
  const candidates = [];
  if (process.env.METERED_DOMAIN) {
    candidates.push(
      'https://' +
        process.env.METERED_DOMAIN +
        '/api/v1/turn/credentials?apiKey=' +
        encodeURIComponent(apiKey)
    );
  }
  candidates.push(
    'https://www.metered.ca/turn/turnCredentials?apiKey=' + encodeURIComponent(apiKey)
  );

  try {
    let data = null;
    let lastStatus = 0;
    for (const url of candidates) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) {
          lastStatus = resp.status;
          continue;
        }
        data = await resp.json();
        break;
      } catch (_) {
        // tenta a próxima URL
      }
    }

    if (!data) {
      return res
        .status(502)
        .json({ error: `Metered indisponível (último HTTP ${lastStatus || 'sem resposta'}).` });
    }

    // A API da Metered devolve um array [{urls, username, credential}].
    // Normaliza para { iceServers: [...] } — o formato que o app.js espera —
    // aceitando também { iceServers: [...] } ou { uris, username, password }.
    let list = null;
    if (Array.isArray(data)) {
      list = data;
    } else if (Array.isArray(data.iceServers)) {
      list = data.iceServers;
    } else if (Array.isArray(data.uris) && data.username) {
      list = data.uris.map((u) => ({
        urls: u,
        username: data.username,
        credential: data.password || data.credential,
      }));
    }

    if (!list || list.length === 0) {
      return res
        .status(502)
        .json({ error: 'Metered não retornou servidores TURN válidos.' });
    }

    // Credenciais têm validade curta (ex.: 1h) — nunca usar cache.
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({ iceServers: list });
  } catch (err) {
    return res.status(500).json({
      error: 'Falha ao obter credenciais TURN.',
      detail: String((err && err.message) || err),
    });
  }
}
