import { useState } from 'react';
import { AlertTriangle, CheckCircle2, UploadCloud } from 'lucide-react';
import { parseNinjaTraderCsvText } from '../domain/csvImport';

const REQUIRED_TYPES = ['accounts', 'strategies', 'orders', 'executions'];

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
      const parsed = [];
      for (const file of files) {
        const text = await readFileAsText(file);
        parsed.push(parseNinjaTraderCsvText(text, file.name));
      }
      setParsedFiles(parsed);

      const grouped = parsed.reduce(
        (acc, item) => {
          if (item.type !== 'unknown') acc[item.type] = item.rows;
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

  const foundTypes = new Set(parsedFiles.map((file) => file.type));
  const missingTypes = REQUIRED_TYPES.filter((type) => !foundTypes.has(type));

  return (
    <section className="upload-panel">
      <label className="upload-dropzone">
        <UploadCloud size={22} />
        <span>{isProcessing ? 'Processing files...' : 'Upload NinjaTrader daily files'}</span>
        <small>Accounts, strategies, orders, and positions/executions. Headers can be in any order.</small>
        <input
          type="file"
          multiple
          accept=".csv"
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
        </div>
      ) : null}
    </section>
  );
}
