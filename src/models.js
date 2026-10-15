import { randomBytes } from 'node:crypto';
import QueryStream from 'pg-query-stream';
import { finished } from 'node:stream/promises';
import { database } from './database.js';

// Parameterized SQL repositories preserve the existing HTTP data shape.
// Nested cart snapshots and receipt payloads use JSONB; indexed fields are columns.
const definitions = {
  products: 'machineId name category flavorColor imageUrl sizes available sortOrder deleted createdAt updatedAt',
  orders: 'machineId tokenNo tokenDate orderCode items total customerName phone status idempotencyKey requestHash razorpayOrderId razorpayPaymentId paymentMethod paidAt servedAt refunded razorpayCreateStartedAt creationError createdAt updatedAt',
  print_jobs: 'machineId type orderId status attempts claimedAt printedAt lastError claimId payload createdAt updatedAt',
  admins: 'email passwordHash sessionVersion role machineIds disabled', settings: 'shopName tagline acceptingOrders agentLastSeenAt agentPrinterStatus receiptHeader receiptFooter prepCopy batchSize agentVersion battery updatedAt',
  machines: 'code name enabled isQa agentKeyHash keyVersion createdAt updatedAt',
  counters: 'seq', refunds: 'paymentId createdAt updatedAt'
};
const jsonFields = new Set(['items', 'sizes', 'payload', 'machineIds']);
function repository(table) {
  const fields = new Set(['_id', ...definitions[table].split(' ')]);
  const name = 'fresh_me.' + table;
  function column(key) { if (!fields.has(key)) throw new Error('Unknown repository field'); return '"' + key + '"'; }
  function parameter(values, key, value) { values.push(jsonFields.has(key) ? JSON.stringify(value) : value); return '$' + values.length; }
  function where(filter, values) {
    return Object.entries(filter).map(([key, value]) => {
      if (key === '$or') return '(' + value.map(f => where(f, values)).join(' OR ') + ')';
      const col = column(key);
      if (value === null) return col + ' IS NULL';
      if (typeof value === 'object' && !(value instanceof Date)) return Object.entries(value).map(([op, operand]) => {
        if (op === '$exists') return col + ' IS ' + (operand ? 'NOT ' : '') + 'NULL';
        if (op === '$in') return operand.length ? col + ' IN (' + operand.map(v => parameter(values, key, v)).join(',') + ')' : 'FALSE';
        const operator = { $lt: '<', $lte: '<=', $gte: '>=', $gt: '>' }[op];
        if (!operator) throw new Error('Unsupported SQL filter');
        return col + ' ' + operator + ' ' + parameter(values, key, operand);
      }).join(' AND ');
      return col + ' = ' + parameter(values, key, value);
    }).join(' AND ') || 'TRUE';
  }
  function ordering(sort = {}) { return Object.entries(sort).map(([k, v]) => column(k) + (v === -1 ? ' DESC' : ' ASC') + ' NULLS LAST').join(','); }
  class Read {
    constructor(filter, single = false) { this.filter = filter; this.single = single; this.options = {}; }
    sort(value) { this.options.sort = value; return this; }
    limit(value) { this.options.limit = value; return this; }
    skip(value) { this.options.offset = value; return this; }
    select(value) { this.options.select = value.split(/\s+/); return this; }
    lean() { return this; }
    sql() {
      const values = [];
      const selected = this.options.select ? [...new Set(['_id', ...this.options.select])] : [...fields].filter(f => f !== 'phone');
      let text = 'SELECT ' + selected.map(column).join(',') + ' FROM ' + name + ' WHERE ' + where(this.filter, values);
      const sort = ordering(this.options.sort);
      if (sort) text += ' ORDER BY ' + sort;
      if (this.single || this.options.limit !== undefined) text += ' LIMIT ' + parameter(values, '', this.single ? 1 : this.options.limit);
      if (this.options.offset) text += ' OFFSET ' + parameter(values, '', this.options.offset);
      return { text, values };
    }
    async execute() { const { rows } = await database().query(this.sql()); return this.single ? rows[0] || null : rows; }
    then(resolve, reject) { return this.execute().then(resolve, reject); }
    async *cursor() {
      const client = await database().connect();
      const { text, values } = this.sql();
      const stream = client.query(new QueryStream(text, values, { batchSize: 100 }));
      try { for await (const row of stream) yield row; }
      finally { stream.destroy(); await finished(stream).catch(() => {}); client.release(); }
    }
  }
  async function create(data, client = database()) {
    if (Array.isArray(data)) { const rows = []; for (const item of data) rows.push(await create(item, client)); return rows; }
    const row = { _id: randomBytes(12).toString('hex'), ...data };
    const keys = Object.keys(row).filter(k => fields.has(k) && row[k] !== undefined);
    const values = [];
    return (await client.query('INSERT INTO ' + name + ' (' + keys.map(column) + ') VALUES (' + keys.map(k => parameter(values, k, row[k])) + ') RETURNING *', values)).rows[0];
  }
  async function update(filter, changes, { sort, many = false } = {}) {
    const values = [];
    const set = changes.$set || (Object.keys(changes).some(k => k.startsWith('$')) ? {} : changes);
    const assignments = Object.entries(set).map(([k, v]) => column(k) + '=' + parameter(values, k, v));
    for (const [k, v] of Object.entries(changes.$inc || {})) assignments.push(column(k) + '=' + column(k) + '+' + parameter(values, k, v));
    if (fields.has('updatedAt')) assignments.push('"updatedAt"=now()');
    if (!assignments.length) throw new Error('Empty update');
    const condition = where(filter, values);
    const order = ordering(sort);
    // Candidate locks recheck concurrent modifications before returning a row.
    return database().query('WITH candidates AS (SELECT _id FROM ' + name + ' WHERE ' + condition + (order ? ' ORDER BY ' + order : '') + (many ? '' : ' LIMIT 1') + ' FOR UPDATE) UPDATE ' + name + ' SET ' + assignments.join(',') + ' WHERE _id IN (SELECT _id FROM candidates) RETURNING *', values);
  }
  return {
    find: (filter = {}) => new Read(filter), findOne: (filter = {}) => new Read(filter, true),
    findById: id => new Read({ _id: id }, true), create,
    async countDocuments(filter = {}) { const values = []; return Number((await database().query('SELECT count(*) FROM ' + name + ' WHERE ' + where(filter, values), values)).rows[0].count); },
    async exists(filter) { return Boolean(await new Read(filter, true)); },
    async findOneAndUpdate(filter, changes, options) { return (await update(filter, changes, options)).rows[0] || null; },
    async findByIdAndUpdate(id, changes) { return (await update({ _id: id }, changes)).rows[0] || null; },
    async updateOne(filter, changes) { const result = await update(filter, changes); return { matchedCount: result.rowCount }; },
    async updateMany(filter, changes) { return update(filter, changes, { many: true }); }
  };
}
export const Product = repository('products');
export const Order = repository('orders');
export const PrintJob = repository('print_jobs');
export const Admin = repository('admins');
export const Settings = repository('settings');
export const Counter = repository('counters');
export const Refund = repository('refunds');
export const Machine = repository('machines');
export async function paymentSummary(range, machineId = 'default') {
  const { rows } = await database().query('SELECT count(*)::integer AS count, COALESCE(sum(total),0)::bigint AS total, count(*) FILTER (WHERE refunded)::integer AS "refundedOrders" FROM fresh_me.orders WHERE "paidAt">=$1 AND "paidAt"<$2 AND "machineId"=$3', [range.$gte, range.$lt, machineId]);
  return [{ ...rows[0], total: Number(rows[0].total), revenue: Number(rows[0].total) }];
}
