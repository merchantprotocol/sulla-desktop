import fs from 'fs';

/**
 * Convert a model2vec float32 safetensors table to the PTN1 int8 format read by
 * PotionEmbedder. Kept free of build-tool imports so unit tests exercise the
 * exact conversion scripts/dependencies/potion.ts runs at postinstall time.
 */
export function convertSafetensorsToInt8(srcPath: string, destPath: string): { rows: number, dim: number } {
  const buf = fs.readFileSync(srcPath);
  const headerLen = Number(buf.readBigUInt64LE(0));
  const header = JSON.parse(buf.toString('utf8', 8, 8 + headerLen));
  const key = Object.keys(header).find(k => k !== '__metadata__');

  if (!key) throw new Error(`${ srcPath }: no tensor found`);
  const { dtype, shape, data_offsets: [start, end] } = header[key];

  if (dtype !== 'F32' || shape.length !== 2) throw new Error(`${ srcPath }: expected 2-D F32 tensor, got ${ dtype } ${ JSON.stringify(shape) }`);
  const [rows, dim] = shape as [number, number];
  const base = 8 + headerLen;
  const src = new Float32Array(rows * dim);

  Buffer.from(src.buffer).set(buf.subarray(base + start, base + end));

  const out = Buffer.alloc(12 + rows * 4 + rows * dim);

  out.write('PTN1', 0, 'latin1');
  out.writeUInt32LE(rows, 4);
  out.writeUInt32LE(dim, 8);
  const scalesOff = 12; const dataOff = 12 + rows * 4;

  for (let r = 0; r < rows; r++) {
    let absmax = 0;

    for (let d = 0; d < dim; d++) absmax = Math.max(absmax, Math.abs(src[r * dim + d]));
    const scale = absmax > 0 ? absmax / 127 : 1;

    out.writeFloatLE(scale, scalesOff + r * 4);
    for (let d = 0; d < dim; d++) {
      const q = Math.max(-127, Math.min(127, Math.round(src[r * dim + d] / scale)));

      out.writeInt8(q, dataOff + r * dim + d);
    }
  }
  fs.writeFileSync(destPath, out);

  return { rows, dim };
}
