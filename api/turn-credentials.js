/* =========================================================================
   FileLink Web — função serverless (Vercel) que entrega credenciais TURN
   -------------------------------------------------------------------------
   O app.js busca TURN dinâmico neste endpoint em vez de usar o relay
   público (openrelay). A chave da conta fica só no servidor, na variável
   de ambiente METERED_API_KEY — nunca vai para o cliente.
   ========================================================================= */

export default async function handler(req, res) {
  // Só aceita GET
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const apiKey = process.env.METERED_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'METERED_API_KEY não configurada no ambiente.' });
  }

  try {
    const url =
      'https://www.metered.ca/turn/turnCredentials?apiKey=' +
      encodeURIComponent(apiKey);
    const resp = await fetch(url);

    if (!resp.ok) {
      return res
        .status(resp.status)
        .json({ error: `Metered respondeu HTTP ${resp.status}` });
    }

    const creds = await resp.json();

    // Credenciais têm validade curta (ex.: 1h) — nunca usar cache.
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json(creds);
  } catch (err) {
    return res.status(500).json({
      error: 'Falha ao obter credenciais TURN.',
      detail: String((err && err.message) || err),
    });
  }
}
