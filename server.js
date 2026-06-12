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

const DEFAULT_INSTANCE = process.env.DEFAULT_INSTANCE_NAME || 'atendimento-zap';
const badClientNames = new Set([
  'entrega grafica',
  'entrega gr?fica',
  'sem nome',
  'desconhecido',
  'unknown',
  'null'
]);

const clienteFields = new Set([
  'nome_cliente',
  'instagram',
  'whatsapp_cartao',
  'cep'
]);

const pedidoFields = new Set([
  'categoria',
  'produto',
  'quantidade',
  'corte',
  'cep',
  'valor_produto',
  'valor_frete',
  'sinal_pago',
  'data_sinal',
  'arte_enviada',
  'arte_aprovada',
  'pagamento_final',
  'postado',
  'link_rastreio',
  'pasta_drive',
  'status',
  'ordem'
]);

const booleanFields = new Set([
  'sinal_pago',
  'arte_enviada',
  'arte_aprovada',
  'pagamento_final',
  'postado'
]);

function cleanText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function cleanClientName(value) {
  const text = cleanText(value);
  if (!text) return null;
  return badClientNames.has(text.toLowerCase()) ? null : text;
}

function normalizeValue(field, value) {
  if (value === undefined) return undefined;
  if (booleanFields.has(field)) return value === true || value === 'true' || value === 'sim' || value === '1';
  if (field === 'quantidade' || field === 'ordem') {
    if (value === null || value === '') return null;
    const parsed = parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (field === 'valor_produto' || field === 'valor_frete') {
    if (value === null || value === '') return null;
    const parsed = Number(String(value).replace(',', '.'));
    return Number.isNaN(parsed) ? null : parsed;
  }
  return cleanText(value);
}

async function getDashboardPedido(client, pedidoId) {
  const result = await client.query(
    'SELECT * FROM dashboard_pedidos_compat WHERE pedido_id=$1',
    [pedidoId]
  );
  return result.rows[0];
}

async function findPedido(client, id) {
  const result = await client.query(`
    SELECT *
    FROM crm_pedidos
    WHERE id::text = $1 OR codigo = $1 OR chatid = $1
    ORDER BY updated_at DESC NULLS LAST, id DESC
    LIMIT 1
  `, [id]);
  return result.rows[0];
}

async function registrarEvento(client, pedido, tipo, descricao, dados, origem = 'dashboard') {
  await client.query(`
    INSERT INTO crm_pedido_eventos (pedido_id, cliente_id, tipo, descricao, dados, origem)
    VALUES ($1, $2, $3, $4, $5::jsonb, $6)
  `, [
    pedido.id,
    pedido.cliente_id,
    tipo,
    descricao,
    JSON.stringify(dados || {}),
    origem
  ]);
}

async function upsertCliente(client, body) {
  const instanceName = cleanText(body.instance_name || body.instanceName) || DEFAULT_INSTANCE;
  const chatid = cleanText(body.chatid);
  if (!chatid) throw new Error('chatid obrigatorio');

  const result = await client.query(`
    INSERT INTO crm_clientes (
      instance_name, chatid, nome_cliente, instagram, whatsapp_cartao, cep, updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,NOW())
    ON CONFLICT (instance_name, chatid) DO UPDATE SET
      nome_cliente = COALESCE(EXCLUDED.nome_cliente, crm_clientes.nome_cliente),
      instagram = COALESCE(EXCLUDED.instagram, crm_clientes.instagram),
      whatsapp_cartao = COALESCE(EXCLUDED.whatsapp_cartao, crm_clientes.whatsapp_cartao),
      cep = COALESCE(EXCLUDED.cep, crm_clientes.cep),
      updated_at = NOW()
    RETURNING *
  `, [
    instanceName,
    chatid,
    cleanClientName(body.nome_cliente),
    cleanText(body.instagram),
    cleanText(body.whatsapp_cartao),
    cleanText(body.cep)
  ]);

  return result.rows[0];
}

async function criarPedido(client, cliente, body) {
  const result = await client.query(`
    INSERT INTO crm_pedidos (
      cliente_id, instance_name, chatid, produto, categoria, quantidade, corte, cep,
      valor_produto, valor_frete, sinal_pago, arte_enviada, arte_aprovada,
      pagamento_final, postado, link_rastreio, pasta_drive, status, ordem,
      created_at, updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW(),NOW())
    RETURNING *
  `, [
    cliente.id,
    cliente.instance_name,
    cliente.chatid,
    cleanText(body.produto),
    cleanText(body.categoria),
    normalizeValue('quantidade', body.quantidade),
    cleanText(body.corte),
    cleanText(body.cep),
    normalizeValue('valor_produto', body.valor_produto),
    normalizeValue('valor_frete', body.valor_frete),
    normalizeValue('sinal_pago', body.sinal_pago || false),
    normalizeValue('arte_enviada', body.arte_enviada || false),
    normalizeValue('arte_aprovada', body.arte_aprovada || false),
    normalizeValue('pagamento_final', body.pagamento_final || false),
    normalizeValue('postado', body.postado || false),
    cleanText(body.link_rastreio),
    cleanText(body.pasta_drive),
    cleanText(body.status) || 'novo',
    normalizeValue('ordem', body.ordem)
  ]);

  const pedido = result.rows[0];
  const codigo = `EG-${new Date(pedido.created_at).getFullYear()}-${String(pedido.id).padStart(6, '0')}`;
  const updated = await client.query(
    'UPDATE crm_pedidos SET codigo=$1 WHERE id=$2 RETURNING *',
    [codigo, pedido.id]
  );
  return updated.rows[0];
}

app.get('/pedidos', async (req, res) => {
  try {
    const { status, data_inicio, data_fim, incluir_sem_sinal } = req.query;
    let query = "SELECT * FROM dashboard_pedidos_compat WHERE COALESCE(status, '') <> 'arquivado'";
    if (incluir_sem_sinal !== 'true') query += ' AND sinal_pago = true';
    const params = [];

    if (status && status !== 'todos') {
      params.push(status);
      query += ` AND status = $${params.length}`;
    }
    if (data_inicio) {
      params.push(data_inicio);
      query += ` AND created_at::date >= $${params.length}::date`;
    }
    if (data_fim) {
      params.push(data_fim);
      query += ` AND created_at::date <= $${params.length}::date`;
    }

    query += ' ORDER BY CASE WHEN ordem IS NULL THEN 1 ELSE 0 END, ordem ASC, COALESCE(data_sinal, updated_at, created_at) DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/pedidos', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cliente = await upsertCliente(client, req.body);
    const pedido = await criarPedido(client, cliente, req.body);
    await registrarEvento(client, pedido, 'pedido_criado', 'Pedido criado pelo dashboard/API', req.body);
    await client.query('COMMIT');
    res.json(await getDashboardPedido(client, pedido.id));
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.patch('/pedidos/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pedido = await findPedido(client, req.params.id);
    if (!pedido) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Nao encontrado' });
    }

    const updates = {};
    if (req.body.campo) {
      if (clienteFields.has(req.body.campo) || pedidoFields.has(req.body.campo)) {
        updates[req.body.campo] = req.body.valor;
      }
    } else {
      Object.keys(req.body).forEach((key) => {
        if (clienteFields.has(key) || pedidoFields.has(key)) updates[key] = req.body[key];
      });
    }

    if (!Object.keys(updates).length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Nenhum campo valido' });
    }

    const clienteUpdates = Object.keys(updates).filter((key) => clienteFields.has(key));
    if (clienteUpdates.length) {
      const values = clienteUpdates.map((key) => key === 'nome_cliente' ? cleanClientName(updates[key]) : normalizeValue(key, updates[key]));
      values.push(pedido.cliente_id);
      const set = clienteUpdates.map((key, index) => `${key}=$${index + 1}`).join(', ');
      await client.query(
        `UPDATE crm_clientes SET ${set}, updated_at=NOW() WHERE id=$${values.length}`,
        values
      );
    }

    const pedidoUpdates = Object.keys(updates).filter((key) => pedidoFields.has(key));
    if (pedidoUpdates.length) {
      const values = pedidoUpdates.map((key) => normalizeValue(key, updates[key]));
      values.push(pedido.id);
      const set = pedidoUpdates.map((key, index) => `${key}=$${index + 1}`).join(', ');
      await client.query(
        `UPDATE crm_pedidos SET ${set}, updated_at=NOW() WHERE id=$${values.length}`,
        values
      );
    }

    if (updates.sinal_pago === true || updates.sinal_pago === 'true' || updates.sinal_pago === 'sim') {
      await client.query(
        'UPDATE crm_pedidos SET data_sinal=COALESCE(data_sinal, NOW()) WHERE id=$1',
        [pedido.id]
      );
    }

    const pedidoAtualizado = (await client.query('SELECT * FROM crm_pedidos WHERE id=$1', [pedido.id])).rows[0];
    await registrarEvento(client, pedidoAtualizado, 'pedido_atualizado', 'Pedido atualizado pelo dashboard/API', updates);
    await client.query('COMMIT');
    res.json(await getDashboardPedido(client, pedido.id));
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.delete('/pedidos/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pedido = await findPedido(client, req.params.id);
    if (!pedido) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Nao encontrado' });
    }
    const updated = await client.query(
      "UPDATE crm_pedidos SET status='arquivado', updated_at=NOW() WHERE id=$1 RETURNING *",
      [pedido.id]
    );
    await registrarEvento(client, updated.rows[0], 'pedido_arquivado', 'Pedido arquivado pelo dashboard/API', {});
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.get('/metricas', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)::INTEGER AS total,
        COUNT(*) FILTER (WHERE sinal_pago = true)::INTEGER AS com_sinal,
        COUNT(*) FILTER (WHERE arte_enviada = false)::INTEGER AS aguardando_arte,
        COUNT(*) FILTER (WHERE arte_enviada = true AND arte_aprovada = false)::INTEGER AS aguardando_aprovacao,
        COUNT(*) FILTER (WHERE arte_aprovada = true AND pagamento_final = false)::INTEGER AS aguardando_pagamento,
        COUNT(*) FILTER (WHERE pagamento_final = true AND postado = false)::INTEGER AS prontos_postar,
        COUNT(*) FILTER (WHERE postado = true)::INTEGER AS postados,
        COALESCE(SUM(COALESCE(valor_produto, 0) + COALESCE(valor_frete, 0)), 0)::DECIMAL(10,2) AS receita_total
      FROM dashboard_pedidos_compat
      WHERE COALESCE(status, '') <> 'arquivado'
        AND sinal_pago = true
    `);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/clientes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        c.id,
        c.instance_name,
        c.chatid,
        c.nome_cliente,
        c.instagram,
        c.whatsapp_cartao,
        c.cep,
        c.origem,
        c.observacoes,
        c.created_at,
        c.updated_at,
        COUNT(p.id)::INTEGER AS total_pedidos,
        COALESCE(SUM(COALESCE(p.valor_produto, 0) + COALESCE(p.valor_frete, 0)), 0)::DECIMAL(10,2) AS valor_total,
        MAX(p.updated_at) AS ultimo_pedido_at
      FROM crm_clientes c
      LEFT JOIN crm_pedidos p ON p.cliente_id = c.id
      GROUP BY c.id
      ORDER BY COALESCE(MAX(p.updated_at), c.updated_at) DESC NULLS LAST
      LIMIT 500
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/clientes/:id', async (req, res) => {
  try {
    const cliente = await pool.query('SELECT * FROM crm_clientes WHERE id=$1', [req.params.id]);
    if (!cliente.rows.length) return res.status(404).json({ error: 'Cliente nao encontrado' });

    const pedidos = await pool.query(`
      SELECT *
      FROM dashboard_pedidos_compat
      WHERE pedido_id IN (SELECT id FROM crm_pedidos WHERE cliente_id=$1)
      ORDER BY updated_at DESC NULLS LAST
    `, [req.params.id]);

    const eventos = await pool.query(`
      SELECT e.*
      FROM crm_pedido_eventos e
      WHERE e.cliente_id=$1
      ORDER BY e.created_at DESC
      LIMIT 100
    `, [req.params.id]);

    res.json({
      cliente: cliente.rows[0],
      pedidos: pedidos.rows,
      eventos: eventos.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/leads', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        l.*,
        c.nome_cliente,
        c.chatid,
        c.instagram,
        c.whatsapp_cartao
      FROM crm_leads l
      JOIN crm_clientes c ON c.id = l.cliente_id
      ORDER BY COALESCE(l.proximo_followup, l.updated_at) DESC NULLS LAST
      LIMIT 500
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/atencao', async (req, res) => {
  try {
    const result = await pool.query(`
      WITH itens AS (
        SELECT
          'arte_atrasada' AS tipo,
          'Arte pendente ha mais de 72h uteis ou pedido antigo sem arte' AS motivo,
          p.id AS pedido_id,
          p.codigo,
          p.chatid,
          c.nome_cliente,
          p.status,
          p.valor_produto,
          p.valor_frete,
          p.sinal_pago,
          p.data_sinal,
          p.arte_enviada,
          p.arte_aprovada,
          p.pagamento_final,
          p.postado,
          p.updated_at,
          p.created_at
        FROM crm_pedidos p
        JOIN crm_clientes c ON c.id = p.cliente_id
        WHERE p.sinal_pago = true
          AND p.arte_enviada = false
          AND COALESCE(p.status, '') NOT IN ('finalizado', 'postado', 'cancelado', 'arquivado')
          AND COALESCE(p.data_sinal, p.created_at) < NOW() - INTERVAL '3 days'

        UNION ALL

        SELECT
          'sem_dados' AS tipo,
          'Pedido com dados importantes faltando' AS motivo,
          p.id AS pedido_id,
          p.codigo,
          p.chatid,
          c.nome_cliente,
          p.status,
          p.valor_produto,
          p.valor_frete,
          p.sinal_pago,
          p.data_sinal,
          p.arte_enviada,
          p.arte_aprovada,
          p.pagamento_final,
          p.postado,
          p.updated_at,
          p.created_at
        FROM crm_pedidos p
        JOIN crm_clientes c ON c.id = p.cliente_id
        WHERE COALESCE(p.status, '') NOT IN ('finalizado', 'postado', 'cancelado', 'arquivado')
          AND (p.produto IS NULL OR p.quantidade IS NULL OR p.cep IS NULL)

        UNION ALL

        SELECT
          'falha_automacao' AS tipo,
          COALESCE(f.erro, 'Falha de automacao aberta') AS motivo,
          f.pedido_id,
          p.codigo,
          COALESCE(f.chatid, p.chatid) AS chatid,
          c.nome_cliente,
          p.status,
          p.valor_produto,
          p.valor_frete,
          p.sinal_pago,
          p.data_sinal,
          p.arte_enviada,
          p.arte_aprovada,
          p.pagamento_final,
          p.postado,
          f.created_at AS updated_at,
          f.created_at
        FROM crm_automacao_falhas f
        LEFT JOIN crm_pedidos p ON p.id = f.pedido_id
        LEFT JOIN crm_clientes c ON c.id = p.cliente_id
        WHERE f.resolvido = false
      )
      SELECT *
      FROM itens
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 300
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/eventos', async (req, res) => {
  try {
    const { pedido_id, cliente_id } = req.query;
    const params = [];
    let where = 'WHERE 1=1';
    if (pedido_id) {
      params.push(pedido_id);
      where += ` AND e.pedido_id = $${params.length}`;
    }
    if (cliente_id) {
      params.push(cliente_id);
      where += ` AND e.cliente_id = $${params.length}`;
    }
    const result = await pool.query(`
      SELECT
        e.*,
        p.codigo,
        c.nome_cliente,
        c.chatid
      FROM crm_pedido_eventos e
      LEFT JOIN crm_pedidos p ON p.id = e.pedido_id
      LEFT JOIN crm_clientes c ON c.id = e.cliente_id
      ${where}
      ORDER BY e.created_at DESC
      LIMIT 300
    `, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`API rodando na porta ${PORT}`));
