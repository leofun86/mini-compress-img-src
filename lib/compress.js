
// lib/compress.js
import sharp from 'sharp';

/**
 * Comprime un Buffer de imagen según formato/calidad.
 * Devuelve { outBuffer, outExt, originalBytes, outBytes, savedBytes }
 * Opcionalmente aplica un ICC embebido (Buffer) si se provee.
 */
export async function compressBuffer(inputBuffer, { format = 'webp', quality = 78, iccBuffer = null } = {}) {
  const pipeline = sharp(inputBuffer, { unlimited: false })
    .rotate()
    .toColorspace('srgb')
    .withMetadata(iccBuffer ? { icc: iccBuffer.toString('binary') } : {});

  let outBuffer;
  let outExt = format.toLowerCase();

  switch (outExt) {
    case 'png':
      outBuffer = await pipeline.png({
        palette: true,
        quality: quality,
        compressionLevel: 9,
        effort: 10,
        progressive: false
      }).toBuffer();
      break;
    case 'avif':
      outBuffer = await pipeline.avif({
        quality: Math.max(Math.round(quality * 0.6), 35),
        speed: 6,
        chromaSubsampling: '4:2:0'
      }).toBuffer();
      break;
    case 'webp':
      outBuffer = await pipeline.webp({
        quality: Math.min(quality + 5, 90),
        effort: 6
      }).toBuffer();
      break;
    case 'jpg':
    case 'jpeg':
    default:
      outExt = 'jpg';
      outBuffer = await pipeline.jpeg({
        mozjpeg: true,
        quality: quality,
        progressive: true,
        chromaSubsampling: '4:2:0',
        overshootDeringing: true
      }).toBuffer();
      break;
  }

  const best = outBuffer.length <= inputBuffer.length ? outBuffer : inputBuffer;
  return {
    outBuffer: best,
    outExt,
    originalBytes: inputBuffer.length,
    outBytes: best.length,
    savedBytes: Math.max(0, inputBuffer.length - best.length)
  };
}
