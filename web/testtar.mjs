import { gzipSync } from 'node:zlib';

// a tiny tar writer: entries are [name, content | null (dir), typeflag?, linkname?]
export function tar(entries) {
  const out = [];
  for (const [name, data, type = data === null ? '5' : '0', link = ''] of entries) {
    const body = data === null ? Buffer.alloc(0) : Buffer.from(data);
    const h = Buffer.alloc(512);
    h.write(name, 0); h.write('0000644\0', 100); h.write(body.length.toString(8).padStart(11, '0') + '\0', 124); h.write(type, 156); h.write(link, 157); h.write('ustar\0', 257);
    out.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  out.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(out));
}
