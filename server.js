const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

app.get('/pedidos', async (req, res) => {
  try {
    const { status, data_inicio, data_fim } = req.query;
    let query = 'SELECT * FROM pedidos_estruturados WHERE 1=1';
    const params = [];
    if (status && status !== 'todos') { params.push(status); query += ` AND status = $${params.length}`; }
    if (data_inicio) { params.push(data_inicio); query += ` AND updated_at >= $${params.length}`; }
    if (data_fim) { params.push(data_fim + ' 23:59:59'); query += ` AND updated_at <= $${params.length}`; }
    query += ' ORDER BY updated_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/pedidos', async (req, res) => {
  try {
    const b = req.body;
    if (!b.chatid) return res.status(400).json({ error: 'chatid obrigatorio' });
    const result = await pool.query(`
      INSERT INTO pedidos_estruturados (
        chatid, nome_cliente, instagram, whatsapp_cartao, categoria,
        produto, quantidade, corte, cep, valor_produto, valor_frete,
        sinal_pago, arte_enviada, arte_aprovada, pagamento_final,
        postado, link_rastreio, pasta_drive, status, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW())
      ON CONFLICT (chatid) DO UPDATE SET
        nome_cliente=EXCLUDED.nome_cliente, instagram=EXCLUDED.instagram,
        whatsapp_cartao=EXCLUDED.whatsapp_cartao, categoria=EXCLUDED.categoria,
        produto=EXCLUDED.produto, quantidade=EXCLUDED.quantidade,
        corte=EXCLUDED.corte, cep=EXCLUDED.cep,
        valor_produto=EXCLUDED.valor_produto, valor_frete=EXCLUDED.valor_frete,
        sinal_pago=EXCLUDED.sinal_pago, arte_enviada=EXCLUDED.arte_enviada,
        arte_aprovada=EXCLUDED.arte_aprovada, pagamento_final=EXCLUDED.pagamento_final,
        postado=EXCLUDED.postado, link_rastreio=EXCLUDED.link_rastreio,
        pasta_drive=EXCLUDED.pasta_drive, status=EXCLUDED.status, updated_at=NOW()
      RETURNING *
    `, [
      b.chatid, b.nome_cliente||null, b.instagram||null, b.whatsapp_cartao||null,
      b.categoria||null, b.produto||null, b.quantidade||null, b.corte||null,
      b.cep||null, b.valor_produto||null, b.valor_frete||null,
      b.sinal_pago||false, b.arte_enviada||false, b.arte_aprovada||false,
      b.pagamento_final||false, b.postado||false,
      b.link_rastreio||null, b.pasta_drive||null, b.status||'novo'
    ]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/pedidos/:chatid', async (req, res) => {
  try {
    const { chatid } = req.params;
    const permitidos = [
      'nome_cliente','instagram','whatsapp_cartao','categoria','produto',
      'quantidade','corte','cep','valor_produto','valor_frete','sinal_pago',
      'data_sinal','arte_enviada','arte_aprovada','pagamento_final','postado',
      'link_rastreio','pasta_drive','status'
    ];
    let updates = {};
    if (req.body.campo && permitidos.includes(req.body.campo)) {
      updates[req.body.campo] = req.body.valor;
    } else {
      Object.keys(req.body).forEach(k => { if (permitidos.includes(k)) updates[k] = req.body[k]; });
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nenhum campo valido' });
    const keys = Object.keys(updates);
    const vals = Object.values(updates);
    vals.push(chatid);
    const set = keys.map((k,i) => `${k}=$${i+1}`).join(', ');
    const result = await pool.query(
      `UPDATE pedidos_estruturados SET ${set}, updated_at=NOW() WHERE chatid=$${vals.length} RETURNING *`,
      vals
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/pedidos/:chatid', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM pedidos_estruturados WHERE chatid=$1 RETURNING chatid',
      [req.params.chatid]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Não encontrado' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/metricas', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE sinal_pago=true) as com_sinal,
        COUNT(*) FILTER (WHERE arte_enviada=false OR arte_enviada IS NULL) as aguardando_arte,
        COUNT(*) FILTER (WHERE arte_enviada=true AND arte_aprovada=false) as aguardando_aprovacao,
        COUNT(*) FILTER (WHERE arte_aprovada=true AND pagamento_final=false) as aguardando_pagamento,
        COUNT(*) FILTER (WHERE pagamento_final=true AND postado=false) as prontos_postar,
        COUNT(*) FILTER (WHERE postado=true) as postados,
        COALESCE(SUM(valor_produto),0) as receita_total
      FROM pedidos_estruturados
    `);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`API rodando na porta ${PORT}`));
