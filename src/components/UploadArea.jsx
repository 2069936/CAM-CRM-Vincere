import { useState } from 'react';
import { AlertTriangle, CheckCircle2, UploadCloud } from 'lucide-react';
import { parseNinjaTraderCsvText, summarizeUploadTypes } from '../domain/csvImport';
import { normalizeAutoImportSnapshot } from '../domain/autoImport';

const SECTIONS = ['accounts', 'strategies', 'orders', 'executions'];

// One snapshot.json carries all four sections, where the CSV route needs four
// separate exports. The rest of the upload path is written against a list of
// per-file results, so a snapshot is presented as the four it stands in for.
// That keeps summarizeUploadTypes, the completeness warning and the file pills
// working unchanged rather than growing a second notion of "complete".
function snapshotAsParsedFiles(fileName, parsed) {
  return SECTIONS.map((section) => ({
    fileName: `${fileName} (${section})`,
    type: section,
    rows: parsed[section] || [],
    errors: [],
  }));
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

export default function UploadArea({ onParsed }) {
  const [parsedFiles, setParsedFiles] = useState([]);
  const [error, setError] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  async function handleFiles(files) {
    setError('');
    setIsProcessing(true);
    try {
      // A snapshot is the whole close in one file, so it is never combined with
      // loose CSVs: doing that would double count whatever they overlap on, and
      // silently, since both routes end in the same reconcile.
      const snapshots = files.filter((file) => /\.json$/i.test(file.name));
      if (snapshots.length && snapshots.length !== files.length) {
        throw new Error('Upload either the four NinjaTrader CSV exports or one snapshot .json from the AddOn, not both at once.');
      }
      if (snapshots.length > 1) {
        throw new Error('Upload one snapshot .json at a time. Each one is a complete close on its own.');
      }

      if (snapshots.length === 1) {
        const file = snapshots[0];
        const text = await readFileAsText(file);
        // normalizeAutoImportSnapshot is the same function the automatic path
        // uses server side, so a file uploaded by hand and a file delivered by
        // the agent are read by identical code and cannot disagree.
        const { parsed: sections } = normalizeAutoImportSnapshot(JSON.parse(text));
        const asFiles = snapshotAsParsedFiles(file.name, sections);
        setParsedFiles(asFiles);
        onParsed(
          SECTIONS.reduce((acc, section) => ({ ...acc, [section]: sections[section] || [] }), {}),
          asFiles,
        );
        return;
      }

      const parsed = [];
      for (const file of files) {
        const text = await readFileAsText(file);
        parsed.push(parseNinjaTraderCsvText(text, file.name));
      }
      setParsedFiles(parsed);
      const parseWarnings = parsed.flatMap(f => (f.errors || []).map(e => `${f.fileName}: ${e.message || e.code}`));
      if (parseWarnings.length) setError(`Parse warnings (data may be incomplete): ${parseWarnings.slice(0,3).join('; ')}`);

      const grouped = parsed.reduce(
        (acc, item) => {
          if (item.type !== 'unknown') acc[item.type] = [...acc[item.type], ...item.rows];
          return acc;
        },
        { accounts: [], strategies: [], orders: [], executions: [] },
      );
      onParsed(grouped, parsed);
    } catch (err) {
      setError(err?.message || 'Could not parse uploaded files.');
    } finally {
      setIsProcessing(false);
    }
  }

  const { missingTypes, unknownFiles } = summarizeUploadTypes(parsedFiles);

  return (
    <section className="upload-panel">
      <label className="upload-dropzone">
        <UploadCloud size={22} />
        <span>{isProcessing ? 'Processing files...' : 'Upload NinjaTrader daily files'}</span>
        <small>The four NinjaTrader exports, or one snapshot .json from the AddOn. Headers can be in any order.</small>
        <input
          type="file"
          multiple
          accept=".csv,.json"
          onChange={(event) => handleFiles(Array.from(event.target.files || []))}
        />
      </label>

      {error ? <div className="notice danger"><AlertTriangle size={16} /> {error}</div> : null}

      {parsedFiles.length > 0 ? (
        <div className="file-grid">
          {parsedFiles.map((file) => (
            <div className="file-pill" key={file.fileName}>
              <CheckCircle2 size={15} />
              <span>{file.fileName}</span>
              <strong>{file.type}</strong>
            </div>
          ))}
          {missingTypes.length ? (
            <div className="notice warning">
              <AlertTriangle size={16} />
              Missing or not detected: {missingTypes.join(', ')}
            </div>
          ) : null}
          {unknownFiles.length ? (
            <div className="notice warning">
              <AlertTriangle size={16} />
              Unrecognized file(s): {unknownFiles.join(', ')} — check the export headers.
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
