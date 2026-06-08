import React, { useState, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { processNinjaTraderData } from './utils/csvParser';
import UploadArea from './components/UploadArea';
import Dashboard from './components/Dashboard';
import AccountManager from './components/AccountManager';
import { LayoutDashboard, Users, Upload, Plus, User } from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  
  // Clients state
  const [clients, setClients] = useState([]);
  const [activeClientId, setActiveClientId] = useState(null);
  const [newClientName, setNewClientName] = useState('');

  // Load clients from localStorage on mount
  useEffect(() => {
    const savedClients = localStorage.getItem('cam_clients');
    if (savedClients) {
      try {
        const parsed = JSON.parse(savedClients);
        // Migration logic for history array instead of top-level accounts/algorithms
        const migrated = parsed.map(c => {
          let updatedClient = { ...c };
          
          if (!updatedClient.uploads) {
            updatedClient.uploads = [];
            // move existing flat data into the first upload entry
            if (updatedClient.accounts && updatedClient.accounts.length > 0) {
              updatedClient.uploads.push({
                id: uuidv4(),
                timestamp: new Date().toISOString(),
                accounts: updatedClient.accounts,
                algorithms: updatedClient.algorithms || []
              });
            }
            delete updatedClient.accounts;
            delete updatedClient.algorithms;
          }
          return updatedClient;
        });
        
        setClients(migrated);
        if (migrated.length > 0) {
          setActiveClientId(migrated[0].id);
        }
      } catch (e) {
        console.error('Failed to parse saved clients', e);
      }
    }
  }, []);

  // Save clients to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem('cam_clients', JSON.stringify(clients));
  }, [clients]);

  const activeClient = clients.find(c => c.id === activeClientId);

  const handleAddClient = (e) => {
    e.preventDefault();
    if (!newClientName.trim()) return;
    
    const newClient = {
      id: uuidv4(),
      name: newClientName.trim(),
      uploads: [],
      accountMeta: {} 
    };
    
    setClients(prev => [...prev, newClient]);
    setActiveClientId(newClient.id);
    setNewClientName('');
  };

  const updateActiveClientData = (updater) => {
    if (!activeClientId) return;
    setClients(prev => prev.map(c => {
      if (c.id === activeClientId) {
        return { ...c, ...updater(c) };
      }
      return c;
    }));
  };

  const updateAccountMeta = (accountName, field, value) => {
    updateActiveClientData(client => {
      const currentMeta = client.accountMeta[accountName] || { bucket: 'unassigned', baseBalance: 50000, target: 3000, risk: '', status: 'Active' };
      return {
        accountMeta: { 
          ...client.accountMeta, 
          [accountName]: { ...currentMeta, [field]: value } 
        }
      };
    });
  };

  const handleDataProcessed = ({ accounts, algorithms }) => {
    updateActiveClientData(client => {
      const newMeta = { ...(client.accountMeta || {}) };
      // Identify new accounts or accounts that disappeared (though we handle disappearance via history now)
      accounts.forEach(acc => {
        if (!newMeta[acc.name]) {
          newMeta[acc.name] = { bucket: 'unassigned', baseBalance: 50000, target: 3000, risk: '', status: 'Active' };
        }
      });

      const newUpload = {
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        accounts,
        algorithms
      };

      return { 
        uploads: [...(client.uploads || []), newUpload],
        accountMeta: newMeta 
      };
    });
    setActiveTab('manager');
  };

  // Get the most recent upload data for display
  const latestUpload = activeClient?.uploads?.length > 0 
    ? activeClient.uploads[activeClient.uploads.length - 1] 
    : { accounts: [], algorithms: [] };

  return (
    <div className="flex h-screen w-full" style={{ background: 'var(--bg-base)' }}>
      {/* Sidebar Redesign */}
      <aside className="w-72 border-r border-[var(--border)] bg-[var(--bg-surface)] flex flex-col">
        <div className="p-6 border-b border-[var(--border)]">
          <h1 className="text-2xl font-bold text-white tracking-tight">CAM <span className="text-[var(--primary)]">Portal</span></h1>
          <p className="text-xs text-muted uppercase tracking-wider mt-1">Workspace</p>
        </div>
        
        {/* Client List */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
          <h2 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">Your Clients</h2>
          
          <div className="flex flex-col gap-2">
            {clients.map(c => (
              <button 
                key={c.id} 
                onClick={() => setActiveClientId(c.id)}
                className={`flex items-center gap-3 p-3 rounded-md transition-all text-left border ${activeClientId === c.id ? 'bg-[hsla(252,87%,67%,0.1)] border-[var(--primary)]' : 'bg-transparent border-transparent hover:bg-[var(--bg-surface-hover)]'}`}
              >
                <div className={`p-2 rounded-full ${activeClientId === c.id ? 'bg-[var(--primary)] text-white' : 'bg-[var(--bg-base)] text-muted'}`}>
                  <User size={16} />
                </div>
                <div className="flex-1 truncate">
                  <p className={`text-sm font-medium ${activeClientId === c.id ? 'text-white' : 'text-[var(--text-main)]'}`}>{c.name}</p>
                  <p className="text-xs text-muted truncate">
                    {c.uploads?.length || 0} syncs
                  </p>
                </div>
              </button>
            ))}
          </div>

          <form onSubmit={handleAddClient} className="mt-4 flex flex-col gap-2 p-3 border border-dashed border-[var(--border)] rounded-md">
            <p className="text-xs text-muted">Add New Client</p>
            <div className="flex gap-2">
              <input 
                type="text" 
                className="input-field flex-1 py-1.5 px-2 text-sm bg-[var(--bg-base)]"
                placeholder="Name" 
                value={newClientName}
                onChange={e => setNewClientName(e.target.value)}
              />
              <button type="submit" className="p-1.5 rounded bg-[var(--bg-base)] hover:bg-[var(--primary)] hover:text-white transition-colors border border-[var(--border)] hover:border-transparent">
                <Plus size={16} />
              </button>
            </div>
          </form>
        </div>

        {/* Navigation Menu */}
        <nav className="border-t border-[var(--border)] flex flex-col gap-1 p-4 bg-[var(--bg-base)]">
          <button 
            onClick={() => setActiveTab('dashboard')}
            className={`btn btn-outline justify-start border-transparent ${activeTab === 'dashboard' ? 'bg-[var(--bg-surface-hover)] text-white' : 'text-muted'}`}
            disabled={!activeClient}
          >
            <LayoutDashboard size={18} /> Dashboard
          </button>
          <button 
            onClick={() => setActiveTab('manager')}
            className={`btn btn-outline justify-start border-transparent ${activeTab === 'manager' ? 'bg-[var(--bg-surface-hover)] text-white' : 'text-muted'}`}
            disabled={!activeClient}
          >
            <Users size={18} /> Accounts
          </button>
          <button 
            onClick={() => setActiveTab('upload')}
            className={`btn btn-outline justify-start border-transparent ${activeTab === 'upload' ? 'bg-[var(--bg-surface-hover)] text-white' : 'text-muted'}`}
            disabled={!activeClient}
          >
            <Upload size={18} /> Sync Data
          </button>
        </nav>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto p-8 relative">
        <div className="container animate-fade-in">
          {!activeClient ? (
            <div className="text-center py-20 flex flex-col items-center">
              <div className="w-20 h-20 rounded-full bg-[var(--bg-surface-hover)] flex items-center justify-center mb-6 border border-[var(--border)]">
                <Users size={32} className="text-muted" />
              </div>
              <h2 className="text-h2 mb-2 text-white">Select a Client</h2>
              <p className="text-muted max-w-sm">Choose an existing client from the sidebar or create a new one to start syncing NinjaTrader data.</p>
            </div>
          ) : (
            <>
              {activeTab === 'upload' && (
                <UploadArea onDataProcessed={handleDataProcessed} clientName={activeClient.name} />
              )}
              {activeTab === 'manager' && (
                <AccountManager 
                  accounts={latestUpload.accounts} 
                  meta={activeClient.accountMeta || {}} 
                  onUpdateMeta={updateAccountMeta} 
                />
              )}
              {activeTab === 'dashboard' && (
                <Dashboard 
                  clientName={activeClient.name}
                  accounts={latestUpload.accounts} 
                  algorithms={latestUpload.algorithms} 
                  meta={activeClient.accountMeta || {}} 
                />
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
