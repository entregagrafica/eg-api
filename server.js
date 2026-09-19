const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
const allowedOrigins = (process.env.DASHBOARD_ALLOWED_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // Requests made locally by a health check have no Origin header.
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origem nao autorizada'));
  }
}));
app.use(express.json());

// When DASHBOARD_API_TOKEN is configured, every dashboard request must carry it.
// Keeping this optional preserves a safe migration path for the current dashboard;
// it must be configured before exposing this API on a public domain.
app.use((req, res, next) => {
  const expected = process.env.DASHBOARD_API_TOKEN;
  if (!expected) return next();
  const authorization = req.get('authorization') || '';
  if (authorization === `Bearer ${expected}`) return next();
  return res.status(401).json({ error: 'Nao autorizado' });
});

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
  'arte_enviada',
  'arte_aprovada',
  'postado',
  'link_rastreio',
  'pasta_drive',
  'status',
  'ordem'
]);

const booleanFields = new Set([
  'arte_enviada',
  'arte_aprovada',
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

async function findPedido(client, id, conversa = {}) {
  if (conversa.instanceName && conversa.chatid) {
    const result = await client.query(`
      SELECT * FROM crm_pedidos
      WHERE instance_name=$1 AND chatid=$2
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT 1
    `, [conversa.instanceName, conversa.chatid]);
    return result.rows[0];
  }
  const result = await client.query(`
    SELECT *
    FROM crm_pedidos
    WHERE id::text = $1 OR codigo = $1 OR chatid = $1
    ORDER BY updated_at DESC NULLS LAST, id DESC
    LIMIT 1
  `, [id]);
  return result.rows[0];
}

async function criarPedidoManualDaConversa(client, conversa = {}) {
  if (!conversa.instanceName || !conversa.chatid) return undefined;
  const cliente = await client.query(`
    INSERT INTO crm_clientes (instance_name, chatid, nome_cliente, whatsapp_cartao, origem, created_at, updated_at)
    VALUES ($1, $2, $3, $2, 'dashboard_manual', NOW(), NOW())
    ON CONFLICT (instance_name, chatid) DO UPDATE SET
      nome_cliente=COALESCE(NULLIF(EXCLUDED.nome_cliente,''), crm_clientes.nome_cliente), updated_at=NOW()
    RETURNING *
  `, [conversa.instanceName, conversa.chatid, conversa.nomeCliente || null]);
  const pedido = await client.query(`
    INSERT INTO crm_pedidos (cliente_id, instance_name, chatid, status, origem, created_at, updated_at)
    VALUES ($1, $2, $3, 'aguardando_material', 'dashboard_manual', NOW(), NOW())
    RETURNING *
  `, [cliente.rows[0].id, conversa.instanceName, conversa.chatid]);
  await client.query(`
    INSERT INTO pedidos_estruturados (instance_name, chatid, nome_cliente, whatsapp_cartao, sinal_pago, status, created_at, updated_at)
    VALUES ($1, $2, $3, $2, false, 'aguardando_material', NOW(), NOW())
    ON CONFLICT (instance_name, chatid) DO UPDATE SET
      nome_cliente=COALESCE(NULLIF(EXCLUDED.nome_cliente,''), pedidos_estruturados.nome_cliente), updated_at=NOW()
  `, [conversa.instanceName, conversa.chatid, conversa.nomeCliente || null]);
  return pedido.rows[0];
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
    false,
    normalizeValue('arte_enviada', body.arte_enviada || false),
    normalizeValue('arte_aprovada', body.arte_aprovada || false),
    false,
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

    query += ' ORDER BY CASE WHEN ordem IS NULL THEN 1 ELSE 0 END, ordem ASC, COALESCE(data_sinal, created_at) DESC';
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

// Contingencia do chat: grava um sinal real a partir de uma midia recebida.
// A data vem da mensagem escolhida e nunca do horario do clique no painel.
app.post('/pedidos/:id/confirmar-sinal-manual', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const conversa = {
      instanceName: cleanText(req.body?.instance_name),
      chatid: cleanText(req.body?.chatid),
      nomeCliente: cleanText(req.body?.nome_cliente)
    };
    let pedido = await findPedido(client, req.params.id, conversa);
    const comprovanteMessageId = cleanText(req.body?.comprovante_message_id);
    let dataDoComprovante = null;
    if (comprovanteMessageId) {
      const comprovante = await client.query(`
        SELECT ocorrido_em FROM crm_mensagens_conversa
        WHERE instance_name=$1 AND chatid=$2 AND message_id=$3 AND direcao='entrada'
        LIMIT 1
      `, [conversa.instanceName || pedido?.instance_name, conversa.chatid || pedido?.chatid, comprovanteMessageId]);
      if (!comprovante.rows.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'O comprovante selecionado nao pertence a esta conversa' });
      }
      dataDoComprovante = comprovante.rows[0].ocorrido_em;
    }
    if (!pedido && comprovanteMessageId) pedido = await criarPedidoManualDaConversa(client, conversa);
    if (!pedido) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Pedido nao encontrado para esta conversa' });
    }
    // O banco protege campos financeiros. A autorizacao vale somente para esta
    // transacao, depois da validacao do comprovante pertencente a conversa.
    await client.query("SELECT set_config('app.payment_authority', 'verified', true)");
    const updated = await client.query(`
      UPDATE crm_pedidos
      SET sinal_pago=true,
          data_sinal=COALESCE(data_sinal, (($2::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date)::timestamp, NOW()),
          status=CASE WHEN COALESCE(arte_enviada,false) THEN 'aguardando_arte' ELSE 'aguardando_material' END,
          updated_at=NOW()
      WHERE id=$1 RETURNING *
    `, [pedido.id, dataDoComprovante]);
    await client.query(`
      UPDATE pedidos_estruturados
      SET sinal_pago=true,
          data_sinal=COALESCE(data_sinal, (($3::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date)::timestamp, NOW()),
          status=CASE WHEN COALESCE(materiais_completos,false) THEN 'aguardando_arte' ELSE 'aguardando_material' END,
          updated_at=NOW()
      WHERE instance_name=$1 AND chatid=$2
    `, [pedido.instance_name, pedido.chatid, dataDoComprovante]);
    await registrarEvento(client, updated.rows[0], 'sinal_confirmado_manual',
      'Sinal marcado manualmente pelo painel', {
        observacao: cleanText(req.body?.observacao),
        comprovante_message_id: comprovanteMessageId || null,
        data_do_comprovante: dataDoComprovante ? String(dataDoComprovante).slice(0, 10) : null
      }, 'dashboard_manual');
    await client.query('COMMIT');
    res.json(await getDashboardPedido(client, pedido.id));
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
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

// Conversation data is read directly from the message ledger. It deliberately
// uses instance_name + chatid: a WhatsApp chat id alone is not globally unique.
app.get('/conversas', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limite, 10) || 100, 1), 300);
    const result = await pool.query(`
      WITH ultima_mensagem AS (
        SELECT DISTINCT ON (m.instance_name, m.chatid)
          m.instance_name, m.chatid, m.texto AS ultima_mensagem,
          m.direcao AS ultima_direcao, m.ocorrido_em AS ultima_atividade
        FROM crm_mensagens_conversa m
        WHERE COALESCE(m.chatid, '') <> ''
        ORDER BY m.instance_name, m.chatid, m.ocorrido_em DESC, m.id DESC
      ), totais AS (
        SELECT instance_name, chatid,
          COUNT(*)::integer AS total_mensagens,
          COUNT(*) FILTER (WHERE direcao ILIKE '%entr%')::integer AS entradas,
          COUNT(*) FILTER (WHERE direcao ILIKE '%said%')::integer AS saidas
        FROM crm_mensagens_conversa
        WHERE COALESCE(chatid, '') <> ''
        GROUP BY instance_name, chatid
      ), clientes AS (
        SELECT DISTINCT ON (instance_name, chatid)
          instance_name, chatid, nome_cliente, instagram
        FROM crm_clientes
        ORDER BY instance_name, chatid, updated_at DESC NULLS LAST
      )
      SELECT u.instance_name, u.chatid,
        COALESCE(c.nome_cliente, NULLIF(split_part(u.chatid, '@', 1), '')) AS nome_cliente,
        c.instagram, u.ultima_mensagem, u.ultima_direcao, u.ultima_atividade,
        t.total_mensagens, t.entradas, t.saidas
      FROM ultima_mensagem u
      JOIN totais t USING (instance_name, chatid)
      LEFT JOIN clientes c USING (instance_name, chatid)
      ORDER BY u.ultima_atividade DESC NULLS LAST
      LIMIT $1
    `, [limit]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/conversas/:instanceName/:chatid/mensagens', async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limite, 10) || 120, 1), 500);
    const result = await pool.query(`
      SELECT message_id, direcao, autor, message_type, texto, ocorrido_em,
        media_url IS NOT NULL AS tem_midia, media_mime_type, media_file_name
      FROM crm_mensagens_conversa
      WHERE instance_name = $1 AND chatid = $2
      ORDER BY ocorrido_em DESC, id DESC
      LIMIT $3
    `, [req.params.instanceName, req.params.chatid, limit]);
    res.json(result.rows.reverse());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The provider URL stays in the database/API only. The browser receives media
// through this authenticated proxy, so an instance token is never exposed.
app.get('/conversas/:instanceName/:chatid/mensagens/:messageId/midia', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT media_url, media_mime_type, media_file_name
      FROM crm_mensagens_conversa
      WHERE instance_name=$1 AND chatid=$2 AND message_id=$3
      LIMIT 1
    `, [req.params.instanceName, req.params.chatid, req.params.messageId]);
    const media = result.rows[0];
    if (!media || !media.media_url) return res.status(404).json({ error: 'Midia indisponivel' });

    const source = new URL(media.media_url);
    const allowedHosts = (process.env.MEDIA_ALLOWED_HOSTS || 'entregagrafica.uazapi.com')
      .split(',').map((host) => host.trim()).filter(Boolean);
    if (source.protocol !== 'https:' || !allowedHosts.includes(source.hostname)) {
      return res.status(400).json({ error: 'Origem de midia nao permitida' });
    }
    const upstream = await fetch(source, { redirect: 'error' });
    if (!upstream.ok) return res.status(502).json({ error: 'Midia nao esta mais disponivel no provedor' });
    const size = Number(upstream.headers.get('content-length') || 0);
    if (size > 25 * 1024 * 1024) return res.status(413).json({ error: 'Arquivo maior que o limite de 25 MB' });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (bytes.length > 25 * 1024 * 1024) return res.status(413).json({ error: 'Arquivo maior que o limite de 25 MB' });
    const safeName = String(media.media_file_name || 'midia').replace(/[^a-zA-Z0-9._ -]/g, '_');
    res.set('Content-Type', media.media_mime_type || upstream.headers.get('content-type') || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${safeName}"`);
    res.set('Cache-Control', 'private, max-age=300');
    return res.send(bytes);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/pagamentos/pix/contexto/:pedidoId', async (req, res) => {
  const client = await pool.connect();
  try {
    const pedido = await findPedido(client, req.params.pedidoId);
    if (!pedido) return res.status(404).json({ error: 'Pedido nao encontrado' });
    if (!pedido.valor_produto) return res.status(400).json({ error: 'Informe o valor do produto antes de confirmar Pix' });
    const comprovantes = await client.query(`
      SELECT message_id, message_type, texto, ocorrido_em
      FROM crm_mensagens_conversa
      WHERE instance_name=$1 AND chatid=$2
        AND (message_type ~* '(image|document|audio)' OR texto ~* 'comprovante|pix|pagamento')
      ORDER BY ocorrido_em DESC, id DESC LIMIT 80
    `, [pedido.instance_name, pedido.chatid]);
    const produtoCentavos = Math.round(Number(pedido.valor_produto) * 100);
    const freteCentavos = Math.round(Number(pedido.valor_frete || 0) * 100);
    res.json({
      pedido_id: pedido.id, instance_name: pedido.instance_name, chatid: pedido.chatid,
      sinal_centavos: Math.round(produtoCentavos / 2),
      restante_centavos: produtoCentavos - Math.round(produtoCentavos / 2) + freteCentavos,
      comprovantes: comprovantes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.post('/pagamentos/pix/confirmar', async (req, res) => {
  const client = await pool.connect();
  try {
    const operatorId = process.env.PIX_OPERATOR_ID;
    const operatorSecret = process.env.PIX_OPERATOR_SECRET;
    if (!operatorId || !operatorSecret) return res.status(503).json({ error: 'Confirmacao manual ainda nao configurada no servidor' });
    const pedido = await findPedido(client, req.body.pedido_id);
    if (!pedido) return res.status(404).json({ error: 'Pedido nao encontrado' });
    const tipo = req.body.tipo === 'restante' ? 'restante' : 'sinal';
    const produtoCentavos = Math.round(Number(pedido.valor_produto || 0) * 100);
    const freteCentavos = Math.round(Number(pedido.valor_frete || 0) * 100);
    const valorCentavos = tipo === 'sinal' ? Math.round(produtoCentavos / 2) : produtoCentavos - Math.round(produtoCentavos / 2) + freteCentavos;
    const result = await client.query(`
      SELECT * FROM crm_confirmar_pix_manual($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    `, [operatorId, operatorSecret, pedido.id, pedido.instance_name, pedido.chatid, tipo,
      valorCentavos, cleanText(req.body.comprovante_message_id), cleanText(req.body.referencia_comprovante),
      req.body.destino_conferido === true, req.body.status_conferido === true,
      req.body.valor_conferido === true, req.body.duplicidade_conferida === true,
      cleanText(req.body.observacao)]);
    const confirmation = result.rows[0];
    if (!confirmation || !confirmation.success) return res.status(400).json({ error: confirmation?.message || 'Confirmacao recusada' });
    return res.json(confirmation);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

app.get('/saude', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'Banco indisponivel' });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`API rodando na porta ${PORT}`));
