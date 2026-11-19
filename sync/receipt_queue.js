'use strict';

// Storage adapter is injected so tests never access a real browser profile.
class ReceiptQueue {
  constructor(storage, key = 'greenville_receipt_queue_v1') { this.storage = storage; this.key = key; }
  read() {
    const raw = this.storage.getItem(this.key);
    const data = raw === null ? {version:1, entries:[]} : JSON.parse(raw);
    if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error('invalid queue');
    return data;
  }
  write(data) { this.storage.setItem(this.key, JSON.stringify(data)); }
  add(receipt) {
    if (!receipt || !receipt.operationId) throw new Error('missing operation id');
    const q = this.read(); const body = JSON.stringify(receipt);
    const old = q.entries.find(e => e.operationId === receipt.operationId);
    if (old) { if (old.body !== body) throw new Error('operation id conflict'); return; }
    q.entries.push({operationId:receipt.operationId, body, status:'pending'});
    this.write(q);
  }
  importLegacy(sales, sentMap) {
    const q = this.read();
    for (const sale of sales) {
      const timestamp = Date.parse(sale.updatedAt || sale.paidAt || sale.deletedAt || sale.date || 0);
      if (sentMap[String(sale.id)] === timestamp) continue;
      const original = JSON.stringify(sale);
      if (!q.entries.some(e => e.legacyBody === original)) q.entries.push({status:'legacy_review', legacyBody:original});
    }
    this.write(q);
  }
  async sendOne(id, transport) {
    const q = this.read(); const entry = q.entries.find(e => e.operationId === id);
    if (!entry) throw new Error('missing queue item');
    if (entry.status === 'uncertain') {
      const status = await transport.status(id, entry.body);
      if (status === 'accepted') {
        const latest = this.read();
        const current = latest.entries.find(e => e.operationId === id);
        if (!current || current.body !== entry.body) throw new Error('queue changed');
        latest.entries = latest.entries.filter(e => e.operationId !== id);
        this.write(latest); return 'accepted';
      }
      if (status !== 'absent') return 'waiting';
    }
    entry.status = 'uncertain'; this.write(q);
    const result = await transport.send(entry.body);
    if (result !== 'accepted') return 'waiting';
    const latest = this.read();
    const current = latest.entries.find(e => e.operationId === id);
    if (!current || current.body !== entry.body) throw new Error('queue changed');
    latest.entries = latest.entries.filter(e => e.operationId !== id);
    this.write(latest);
    return 'accepted';
  }
}
if (typeof module !== 'undefined') module.exports = {ReceiptQueue};
