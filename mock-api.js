// โหมดจำลองในเบราว์เซอร์: ถ้าไม่มีเซิร์ฟเวอร์ /api (เช่น GitHub Pages ตอบ 404) จะจำลอง /api/data, /api/dispense, /api/admin
// โดยเก็บข้อมูลใน localStorage ของเครื่องนี้ ถ้ามีเซิร์ฟเวอร์จริงจะส่งต่อให้เซิร์ฟเวอร์ตามปกติ
(function () {
  const real = window.fetch.bind(window), K = 'pharm_mock_v2', CODE = 'admin1234';
  let mode = null, mem = null;
  // ตรวจครั้งเดียวว่ามี API จริงไหม (ต้องตอบ JSON ที่มี drugs)
  const probe = () => mode || (mode = (async () => {
    const c = new AbortController(), t = setTimeout(() => c.abort(), 4000);
    try { const r = await real('/api/data', {signal: c.signal}); const j = r.ok ? await r.json() : null; return j && j.drugs ? 'server' : 'mock'; }
    catch (e) { return 'mock'; } finally { clearTimeout(t); }
  })());
  window.apiMode = probe;
  window.resetMock = () => { mem = null; try { localStorage.removeItem(K); } catch (e) {} };
  const save = () => { try { localStorage.setItem(K, JSON.stringify(mem)); } catch (e) {} };
  async function load() {
    if (mem) return mem;
    try { const s = localStorage.getItem(K); if (s) { mem = JSON.parse(s); return mem; } } catch (e) {}
    const [drugs, stock, log, catalog] = await Promise.all(['drugs', 'stock', 'dispense-log', 'catalog'].map(n => real(n + '.json').then(r => r.json())));
    mem = {drugs, stock, dispense_log: log, catalog}; save(); return mem;
  }
  const R = (code, b) => new Response(JSON.stringify(b), {status: code, headers: {'Content-Type': 'application/json'}});
  const usable = (s, asOf) => (s.status === undefined || s.status === 'active') && s.expiry && s.expiry >= asOf && s.qty_on_hand > 0;
  function dispense(b) {
    const fail = message => ({ok: false, message});
    const sku = String(b.sku || ''), qty = b.qty, pc = String(b.patient_code || '').trim(), ph = String(b.pharmacist_code || '').trim();
    if (!Number.isInteger(qty) || qty < 1) return fail('จำนวนต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป');
    if (!/^[A-Za-z0-9-]{3,20}$/.test(pc)) return fail('รหัสผู้ป่วยใช้ได้เฉพาะ A-Z ตัวเลข และ - (3-20 ตัว) ห้ามใส่ชื่อจริง');
    if (!/^[A-Za-z0-9-]{2,20}$/.test(ph)) return fail('รหัสเภสัชกรไม่ถูกต้อง');
    const asOf = mem.stock.meta.as_of, drug = mem.drugs.items.find(x => x.sku === sku), cat = mem.catalog.items.find(c => c.sku === sku);
    if (!drug || (cat && cat.is_active === false)) return fail('ไม่พบยานี้ในรายการที่จ่ายได้');
    const lots = mem.stock.items.filter(s => s.sku === sku && usable(s, asOf)).sort((a, c) => a.expiry.localeCompare(c.expiry));
    const before = lots.reduce((n, s) => n + s.qty_on_hand, 0), price = drug.price || 0;
    if (qty > before) return fail('ยอดใช้ได้ไม่พอ ต้องการ ' + qty + ' แต่มี ' + before);
    let left = qty; const lines = [], now = asOf + 'T' + new Date().toTimeString().slice(0, 8);
    for (const s of lots) {
      if (left === 0) break;
      const take = Math.min(left, s.qty_on_hand); s.qty_on_hand -= take; left -= take;
      const id = 'D-' + String(mem.dispense_log.items.length + 1).padStart(4, '0');
      lines.push({dispense_id: id, lot: s.lot, qty: take, amount: take * price});
      mem.dispense_log.items.push({dispense_id: id, sku, lot: s.lot, qty: take, unit_price: price, amount: take * price, patient_code: pc, pharmacist_code: ph, dispensed_at: now});
    }
    save(); return {ok: true, lines, usable_before: before, usable_after: before - qty, amount: qty * price};
  }
  async function emu(path, init) {
    const m = await load(), h = (init && init.headers) || {};
    if (path === '/api/data') return R(200, m);
    if (path === '/api/admin') return h['X-Admin-Code'] === CODE ? R(200, m) : R(401, {ok: false, message: 'รหัสผู้ดูแลไม่ถูกต้อง'});
    let b; try { b = JSON.parse(init.body); } catch (e) { return R(400, {ok: false, message: 'ข้อมูลที่ส่งมาไม่ถูกต้อง'}); }
    const r = dispense(b || {}); return R(r.ok ? 200 : 400, r);
  }
  window.fetch = async function (input, init) {
    const p = String(typeof input === 'string' ? input : input.url).split('?')[0];
    if (!/^\/api\/(data|dispense|admin)$/.test(p)) return real(input, init);
    return (await probe()) === 'server' ? real(input, init) : emu(p, init);
  };
})();
