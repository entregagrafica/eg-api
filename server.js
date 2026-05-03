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

// GET todos os pedidos com filtros opcionais
app.get('/pedidos', async (req, res) => {
  try {
    const { status, data_inicio, data_fim } = req.query;
    let query = 'SELECT * FROM pedidos_estruturados WHERE 1=1';
    const params = [];

    if (status && status !== 'todos') {
      params.push(status);
      query += ` AND status = $${params.length}`;
    }

    if (data_inicio) {
      params.push(data_inicio);
      query += ` AND updated_at >= $${params.length}`;
    }

    if (data_fim) {
      params.push(data_fim + ' 23:59:59');
      query += ` AND updated_at <= $${params.length}`;
    }

    query += ' ORDER BY updated_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH atualizar status de um pedido
app.patch('/pedidos/:chatid', async (req, res) => {
  try {
    const { chatid } = req.params;
    const { campo, valor } = req.body;

    const camposPermitidos = [
      'arte_enviada', 'arte_aprovada', 'sinal_pago',
      'pagamento_final', 'postado', 'status', 'link_rastreio'
    ];

    if (!camposPermitidos.includes(campo)) {
      return res.status(400).json({ error: 'Campo não permitido' });
    }

    const query = `
      UPDATE pedidos_estruturados 
      SET ${campo} = $1, updated_at = NOW()
      WHERE chatid = $2
      RETURNING *
    `;

    const result = await pool.query(query, [valor, chatid]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pedido não encontrado' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET resumo/métricas
app.get('/metricas', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE sinal_pago = true) as com_sinal,
        COUNT(*) FILTER (WHERE arte_enviada = false OR arte_enviada IS NULL) as aguardando_arte,
        COUNT(*) FILTER (WHERE arte_enviada = true AND arte_aprovada = false) as aguardando_aprovacao,
        COUNT(*) FILTER (WHERE arte_aprovada = true AND pagamento_final = false) as aguardando_pagamento,
        COUNT(*) FILTER (WHERE pagamento_final = true AND postado = false) as prontos_postar,
        COUNT(*) FILTER (WHERE postado = true) as postados,
        COALESCE(SUM(valor_produto), 0) as receita_total
      FROM pedidos_estruturados
    `);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`API rodando na porta ${PORT}`));
