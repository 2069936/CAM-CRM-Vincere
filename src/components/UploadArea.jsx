import React, { useCallback, useState } from 'react';
import { UploadCloud, FileType, CheckCircle } from 'lucide-react';
import { processNinjaTraderData } from '../utils/csvParser';

export default function UploadArea({ onDataProcessed, clientName }) {
  const [isDragging, setIsDragging] = useState(false);
  const [files, setFiles] = useState([]);
  const [processing, setProcessing] = useState(false);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const droppedFiles = Array.from(e.dataTransfer.files);
      setFiles(droppedFiles);
      processFiles(droppedFiles);
    }
  }, []);

  const handleFileInput = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      const selectedFiles = Array.from(e.target.files);
      setFiles(selectedFiles);
      processFiles(selectedFiles);
    }
  };

  const processFiles = async (filesToProcess) => {
    setProcessing(true);
    try {
      const data = await processNinjaTraderData(filesToProcess);
      setTimeout(() => {
        onDataProcessed(data);
        setProcessing(false);
      }, 800);
    } catch (error) {
      console.error('Error processing files', error);
      setProcessing(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto mt-8">
      <div className="mb-6">
        <h2 className="text-h2 mb-2">Upload Data for {clientName}</h2>
        <p className="text-muted">Upload your NinjaTrader CSV grids (Accounts, Strategies, Orders, Executions) to update the dashboard.</p>
      </div>

      <div 
        className={`dropzone ${isDragging ? 'active' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
      >
        <UploadCloud size={64} className="dropzone-icon mx-auto mb-4" />
        <h3 className="text-h3 mb-2">Drag & Drop files here</h3>
        <p className="text-muted mb-6">or click to browse your computer</p>
        
        <input 
          type="file" 
          multiple 
          accept=".csv"
          className="hidden" 
          id="file-upload" 
          onChange={handleFileInput}
        />
        <label htmlFor="file-upload" className="btn btn-primary">
          Browse Files
        </label>
      </div>

      {files.length > 0 && (
        <div className="mt-8 card">
          <h3 className="card-title mb-4">Selected Files</h3>
          <ul className="flex flex-col gap-2">
            {files.map((f, i) => (
              <li key={i} className="flex items-center gap-3 p-3 rounded-md bg-[var(--bg-base)] border border-[var(--border)]">
                <FileType size={20} className="text-[var(--primary)]" />
                <span className="flex-1 text-sm">{f.name}</span>
                {processing ? (
                  <span className="text-xs text-muted">Processing...</span>
                ) : (
                  <CheckCircle size={20} className="text-[var(--success)]" />
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
