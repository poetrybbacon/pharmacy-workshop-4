// เซิร์ฟเวอร์จำลองสำหรับ workshop: ไม่ต้องติดตั้งแพ็กเกจ รัน node server.js (Node 18+)
// เสิร์ฟหน้าเว็บ + /api/data + /api/dispense + /api/admin โดยอ่าน/เขียนไฟล์ JSON ในโฟลเดอร์นี้
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 3000;
const ADMIN_CODE = process.env.ADMIN_CODE || 'admin1234';   // รหัสผู้ดูแล (ข้อมูลจำลอง ควรเปลี่ยนก่อนใช้งานจริง)
const F = {drugs:'drugs.json', stock:'stock.json', log:'dispense-log.json', catalog:'catalog.json'};

if (process.argv.includes('--reset')) {            // node server.js --reset คืนข้อมูลตั้งต้น
  for (const f of Object.values(F)) fs.copyFileSync(path.join(__dirname,'seed',f), path.join(__dirname,f));
  console.log('รีเซ็ตข้อมูลจำลองแล้ว');
}
const read = f => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
const write = (f, o) => fs.writeFileSync(path.join(__dirname, f), JSON.stringify(o, null, 2));
const snapshot = () => ({drugs:read(F.drugs), stock:read(F.stock), dispense_log:read(F.log), catalog:read(F.catalog)});
const usable = (s, asOf) => (s.status === undefined || s.status === 'active') && s.expiry && s.expiry >= asOf && s.qty_on_hand > 0;

// ตัดสต็อกแบบ FEFO: ล็อตที่หมดอายุก่อนถูกตัดก่อน ผู้ใช้เลือกล็อตเองไม่ได้
function dispense(b) {
  const fail = message => ({ok:false, message});
  const sku = String(b.sku || ''), qty = b.qty;
  const pc = String(b.patient_code || '').trim(), ph = String(b.pharmacist_code || '').trim();
  if (!Number.isInteger(qty) || qty < 1) return fail('จำนวนต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป');
  if (!/^[A-Za-z0-9-]{3,20}$/.test(pc)) return fail('รหัสผู้ป่วยใช้ได้เฉพาะ A-Z ตัวเลข และ - (3-20 ตัว) ห้ามใส่ชื่อจริง');
  if (!/^[A-Za-z0-9-]{2,20}$/.test(ph)) return fail('รหัสเภสัชกรไม่ถูกต้อง');
  const d = snapshot(), asOf = d.stock.meta.as_of;
  const cat = d.catalog.items.find(c => c.sku === sku);
  if (!d.drugs.items.some(x => x.sku === sku) || (cat && cat.is_active === false)) return fail('ไม่พบยานี้ในรายการที่จ่ายได้');
  const price = (d.drugs.items.find(x => x.sku === sku) || {}).price || 0;
  const lots = d.stock.items.filter(s => s.sku === sku && usable(s, asOf)).sort((a,b) => a.expiry.localeCompare(b.expiry));
  const before = lots.reduce((n, s) => n + s.qty_on_hand, 0);
  if (qty > before) return fail(`ยอดใช้ได้ไม่พอ ต้องการ ${qty} แต่มี ${before}`);
  let left = qty; const lines = [], now = asOf + 'T' + new Date().toTimeString().slice(0, 8);
  for (const s of lots) {
    if (left === 0) break;
    const take = Math.min(left, s.qty_on_hand);
    s.qty_on_hand -= take; left -= take;
    const id = 'D-' + String(d.dispense_log.items.length + 1).padStart(4, '0');
    lines.push({dispense_id:id, lot:s.lot, qty:take, amount:take * price});
    d.dispense_log.items.push({dispense_id:id, sku, lot:s.lot, qty:take, unit_price:price, amount:take * price, patient_code:pc, pharmacist_code:ph, dispensed_at:now});
  }
  write(F.stock, d.stock); write(F.log, d.dispense_log);
  return {ok:true, lines, usable_before:before, usable_after:before - qty, amount:qty * price};
}

const TYPES = {'.html':'text/html; charset=utf-8', '.json':'application/json; charset=utf-8'};
const PUBLIC = /^\/(index|pos|admin|dashboard|status)\.html$|^\/(drugs|stock|dispense-log)\.json$/;
const send = (res, code, body, type = TYPES['.json']) => { res.writeHead(code, {'Content-Type':type, 'Cache-Control':'no-store'}); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  try {
    if (req.method === 'GET' && url === '/api/data') return send(res, 200, snapshot());
    if (req.method === 'GET' && url === '/api/admin') {
      if (req.headers['x-admin-code'] !== ADMIN_CODE) return send(res, 401, {ok:false, message:'รหัสผู้ดูแลไม่ถูกต้อง'});
      return send(res, 200, snapshot());
    }
    if (req.method === 'POST' && url === '/api/dispense') {
      let raw = '';
      req.on('data', c => { raw += c; if (raw.length > 10000) req.destroy(); });
      return req.on('end', () => {
        let b; try { b = JSON.parse(raw); } catch (e) { return send(res, 400, {ok:false, message:'ข้อมูลที่ส่งมาไม่ถูกต้อง'}); }
        const r = dispense(b || {}); send(res, r.ok ? 200 : 400, r);
      });
    }
    const p = url === '/' ? '/index.html' : url;
    if (req.method === 'GET' && PUBLIC.test(p)) return send(res, 200, fs.readFileSync(path.join(__dirname, p)), TYPES[path.extname(p)]);
    send(res, 404, {ok:false, message:'ไม่พบหน้านี้'});
  } catch (e) { send(res, 500, {ok:false, message:'เซิร์ฟเวอร์ผิดพลาด'}); }
}).listen(PORT, () => console.log(`เปิดที่ http://localhost:${PORT}  (รหัสผู้ดูแล: ${ADMIN_CODE})`));
