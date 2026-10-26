#!/usr/bin/env node
/**
 * Лёгкие копии картинок лендинга: AVIF/WebP для фотографий и уменьшенные
 * логотипы под srcset. Оригиналы (JPG/PNG) не трогаются — они остаются
 * запасным вариантом для браузеров без AVIF/WebP и источником для пересборки.
 *
 * Запуск (из корня проекта, после замены любой картинки в assets/):
 *
 *   npm i --no-save sharp@0.35.5 && node tools/optimize-images.mjs
 *
 * sharp нарочно не в package.json: он нужен только здесь, а функциям Vercel
 * и Docker-образу тащить нативный модуль незачем. Готовые файлы лежат в git.
 *
 * Выход детерминирован (те же входы и версия sharp — те же байты), так что
 * повторный запуск без новых картинок не даёт изменений в git.
 *
 * Кэш: /assets/* отдаётся с `immutable` на год (vercel.json), поэтому ссылки
 * на эти файлы в index.html несут ?v=N. Заменили картинку — поднимите N
 * в index.html и запустите tools/build-langs.py, иначе вернувшиеся
 * посетители год будут видеть старую.
 */
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let sharp;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.error('Нужен sharp: npm i --no-save sharp@0.35.5 && node tools/optimize-images.mjs');
  process.exit(1);
}

const ASSETS = join(dirname(dirname(fileURLToPath(import.meta.url))), 'assets');

// Фотографии под тёмной подложкой (секции «Оборудование» и «Достижения»):
// размер тот же, меняется только формат. Качество подобрано так, чтобы
// разница с JPG не была видна под градиентом карточки.
const PHOTOS = [
  'ach-1.jpg', 'ach-2.jpg', 'ach-3.jpg', 'ach-4.jpg', 'ach-5.jpg',
  'equip-lego.jpg', 'equip-arduino.jpg', 'equip-drones.jpg',
  'equip-sensors.jpg', 'equip-mechanics.jpg', 'equip-code.jpg',
];

// Логотипы с прозрачностью: WebP без потерь (те же пиксели, меньше байт)
// и уменьшенные копии под фактический размер на экране.
//   logo.png        — шапка, 97×40 (78×32 на телефоне)
//   logo-light.png  — герой, 240–520 px в ширину; подвал, 126×52
// Ширины кратны 75: оригинал 900×372 = 75:31, и только так у копии ровно
// те же пропорции. Иначе высота после загрузки отличается на доли пикселя
// и всё, что ниже, сдвигается (скрипт проверяет это сам).
const LOGOS = {
  'logo.png': [225, 450],
  'logo-light.png': [450],
};

const out = [];
async function save(pipeline, name, src) {
  const info = await pipeline.toFile(join(ASSETS, name));
  out.push([name, info.size, src]);
}

for (const file of PHOTOS) {
  const src = join(ASSETS, file);
  const base = file.replace(/\.jpg$/, '');
  await save(sharp(src).avif({ quality: 60, effort: 6, chromaSubsampling: '4:2:0' }), `${base}.avif`, file);
  await save(sharp(src).webp({ quality: 80, effort: 6 }), `${base}.webp`, file);
}

for (const [file, widths] of Object.entries(LOGOS)) {
  const src = join(ASSETS, file);
  const base = file.replace(/\.png$/, '');
  await save(sharp(src).webp({ lossless: true, effort: 6 }), `${base}.webp`, file);
  const { width, height } = await sharp(src).metadata();
  for (const w of widths) {
    if ((w * height) % width) throw new Error(`${file}: ширина ${w} не сохраняет пропорции ${width}×${height}`);
    const resized = () => sharp(src).resize({ width: w, kernel: 'lanczos3' });
    await save(resized().png({ compressionLevel: 9, palette: false }), `${base}-${w}.png`, file);
    await save(resized().webp({ lossless: true, effort: 6 }), `${base}-${w}.webp`, file);
  }
}

for (const [name, size, src] of out) {
  const before = (await stat(join(ASSETS, src))).size;
  console.log(`  ${name.padEnd(22)} ${String(Math.round(size / 1024)).padStart(4)} KB   (${src}: ${Math.round(before / 1024)} KB)`);
}
