// Smallest possible PDF writer: one A4 portrait page per JPEG image.
// images: [{ bytes: Uint8Array (JPEG file), width, height }]  ->  Uint8Array (PDF file)
const A4_W = 595.28;
const A4_H = 841.89;

export function buildPdf(images) {
  if (!images.length) throw new Error('Nothing to put in the PDF');
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let size = 0;
  const push = (d) => {
    const b = typeof d === 'string' ? enc.encode(d) : d;
    parts.push(b);
    size += b.length;
  };
  const begin = (n) => { offsets[n] = size; push(`${n} 0 obj\n`); };

  push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // %PDF-1.4 + binary marker

  const pageNo = (i) => 3 + i * 3;
  begin(1); push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  begin(2);
  push(`<< /Type /Pages /Kids [${images.map((_, i) => `${pageNo(i)} 0 R`).join(' ')}] /Count ${images.length} >>\nendobj\n`);

  images.forEach((img, i) => {
    const page = pageNo(i);
    const content = `q ${A4_W} 0 0 ${A4_H} 0 0 cm /Im0 Do Q`;
    begin(page);
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4_W} ${A4_H}] /Resources << /XObject << /Im0 ${page + 2} 0 R >> >> /Contents ${page + 1} 0 R >>\nendobj\n`);
    begin(page + 1);
    push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
    begin(page + 2);
    push(`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`);
    push(img.bytes);
    push('\nendstream\nendobj\n');
  });

  const count = 3 + images.length * 3; // object numbers 0..count-1
  const xref = size;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
