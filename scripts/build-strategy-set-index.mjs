import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStrategySetRecord } from '../src/domain/xmlMatch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const defaultSetFilesDir = path.join(rootDir, 'Vincere Trading 6.0', '3 - Set Files');
const sourceDir = process.argv[2] ? path.resolve(process.argv[2]) : defaultSetFilesDir;
const outputPath = process.argv[3] ? path.resolve(process.argv[3]) : path.join(rootDir, 'public', 'strategy-set-index.json');

async function listXmlFiles(dir) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listXmlFiles(fullPath);
    return entry.isFile() && entry.name.toLowerCase().endsWith('.xml') ? [fullPath] : [];
  }));
  return files.flat();
}

const xmlFiles = await listXmlFiles(sourceDir);
const records = [];

for (const filePath of xmlFiles) {
  const xml = await readFile(filePath, 'utf8');
  const relativePath = path.relative(sourceDir, filePath);
  records.push(buildStrategySetRecord({
    fileName: path.basename(filePath),
    relativePath,
    xml,
  }));
}

records.sort((a, b) => String(a.relativePath).localeCompare(String(b.relativePath)));

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  sourceDir,
  count: records.length,
  records,
}, null, 2)}\n`);

console.log(`Wrote ${records.length} strategy set records to ${outputPath}`);
