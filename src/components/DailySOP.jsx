import { useEffect, useState } from 'react';
import { CheckSquare, Square, RotateCcw, Zap } from 'lucide-react';
import { isSupabaseConfigured } from '../lib/supabaseClient';
import { loadSupabaseDailySop, loadSupabaseDailySopTemplate, saveSupabaseDailySop } from '../domain/supabaseStore';
import { computeNewStreak } from './dailySopUtils';

function normalizeSections(sections = []) {
  return (sections || []).map((section, sIdx) => ({
    ...section,
    key: section.key || String(sIdx),
    time: section.time || '',
    items: (section.items || []).map((item, iIdx) => {
      if (typeof item === 'string') {
        return { key: `${sIdx}-${iIdx}`, text: item };
      }
      return {
        key: item.key || item.item_key || `${sIdx}-${iIdx}`,
        text: item.text || '',
      };
    }),
  }));
}

function validCheckedItems(checkedItems = {}, sections = []) {
  const validKeys = new Set(
    sections.flatMap((section) => (section.items || []).map((item) => item.key)),
  );
  return Object.fromEntries(
    Object.entries(checkedItems || {}).filter(([key]) => validKeys.has(key)),
  );
}

export default function DailySOP({ camProfileId = '' }) {
  const today = new Date().toISOString().slice(0, 10);
  const [template, setTemplate] = useState(() => ({
    id: null,
    name: 'Daily CAM Checklist',
    editableByRole: 'Manager',
    sections: [],
  }));
  const sections = template.sections || [];
  const totalItems = sections.reduce((sum, s) => sum + s.items.length, 0);

  const [checked, setChecked] = useState({});
  const [justCompleted, setJustCompleted] = useState(false);
  const [streak, setStreak] = useState({ count: 0, lastDate: '' });
  const [remoteStatus, setRemoteStatus] = useState(() => (
    isSupabaseConfigured && camProfileId ? 'loading' : 'error'
  ));

  useEffect(() => {
    if (!isSupabaseConfigured || !camProfileId) {
      setRemoteStatus('error');
      return;
    }
    let cancelled = false;
    Promise.all([
      loadSupabaseDailySopTemplate(),
      loadSupabaseDailySop(camProfileId, today),
    ])
      .then(([loadedTemplate, row]) => {
        if (cancelled) return;
        let normalized = [];
        if (loadedTemplate?.sections?.length) {
          normalized = normalizeSections(loadedTemplate.sections);
          setTemplate({
            ...loadedTemplate,
            sections: normalized,
          });
        }
        if (row) {
          setChecked(validCheckedItems(row.checked_items || {}, normalized));
          setStreak({
            count: Number(row.streak_count || 0),
            lastDate: row.streak_last_date || '',
          });
        }
        setRemoteStatus('connected');
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('[CRM] Failed to load Daily SOP from Supabase:', error);
        setRemoteStatus('error');
      });
    return () => { cancelled = true; };
  }, [camProfileId, today]);

  function persistDailySop(nextChecked, nextStreak, completedAt = null) {
    if (!isSupabaseConfigured || !camProfileId) return;
    saveSupabaseDailySop(camProfileId, today, nextChecked, nextStreak, completedAt, template.id).catch((error) => {
      console.error('[CRM] Failed to save Daily SOP to Supabase:', error);
      setRemoteStatus('error');
    });
  }

  function toggle(itemKey) {
    setChecked((prev) => {
      const next = { ...prev, [itemKey]: !prev[itemKey] };
      const doneCount = Object.values(next).filter(Boolean).length;
      const wasComplete = Object.values(prev).filter(Boolean).length === totalItems;
      const isNowComplete = doneCount === totalItems;
      const nextStreak = isNowComplete && !wasComplete
        ? computeNewStreak(today, streak, wasComplete, isNowComplete)
        : streak;
      setStreak(nextStreak);
      persistDailySop(next, nextStreak, isNowComplete ? new Date().toISOString() : null);
      if (isNowComplete && !wasComplete) setJustCompleted(true);
      return next;
    });
  }

  function reset() {
    setChecked({});
    setJustCompleted(false);
    persistDailySop({}, streak, null);
  }

  const doneItems = Object.values(checked).filter(Boolean).length;
  const pct = totalItems ? Math.round((doneItems / totalItems) * 100) : 0;
  const isComplete = pct === 100;
  const currentStreak = (() => {
    if (streak.lastDate === today) return streak.count;
    const prev = new Date();
    do { prev.setDate(prev.getDate() - 1); } while ([0, 6].includes(prev.getDay()));
    return streak.lastDate === prev.toISOString().slice(0, 10) ? streak.count : 0;
  })();

  // Determine which section is currently active (first incomplete)
  const activeSectionIdx = sections.findIndex((section) =>
    section.items.some((item) => !checked[item.key])
  );

  return (
    <div className="daily-sop">
      <section className={`panel${isComplete ? ' sop-complete-panel' : ''}`}>
        <div className="panel-heading">
          <h3>{template.name || 'Daily CAM Checklist'}</h3>
          <span className="badge muted">{today}</span>
          {remoteStatus === 'connected' ? <span className="badge positive">Supabase</span> : null}
          {remoteStatus === 'loading' ? <span className="badge muted">Syncing</span> : null}
          {remoteStatus === 'error' ? <span className="badge negative">Sync error</span> : null}
          <span className="count">{doneItems}/{totalItems}</span>
          {currentStreak > 1 && (
            <span className="sop-streak-badge"><Zap size={12} />{currentStreak} day streak</span>
          )}
          <button className="ghost-button" onClick={reset} title="Reset today's checklist">
            <RotateCcw size={14} /> Reset
          </button>
        </div>

        <div className="sop-progress-bar-wrap">
          <div
            className="sop-progress-bar"
            style={{
              width: `${pct}%`,
              background: isComplete
                ? 'var(--success)'
                : pct >= 60
                ? 'linear-gradient(90deg, var(--blue), var(--accent))'
                : 'var(--blue)',
              transition: 'width 0.3s ease, background 0.4s ease',
            }}
          />
        </div>
        <div className="sop-progress-label" style={{ color: isComplete ? 'var(--success)' : undefined }}>
          {isComplete ? '✓ All done - great work today!' : `${pct}% complete · ${totalItems - doneItems} remaining`}
        </div>

        {isComplete && justCompleted && (
          <div className="sop-celebrate">
            <CheckSquare size={16} className="positive" />
            <strong>Day complete!</strong>
            <span className="muted">All {totalItems} checklist items done.</span>
            {currentStreak > 1 && <span className="sop-streak-badge"><Zap size={12} />{currentStreak}-day streak!</span>}
          </div>
        )}

        {sections.map((section, sIdx) => {
          const sectionDone = section.items.filter((item) => checked[item.key]).length;
          const sectionComplete = sectionDone === section.items.length;
          const isActive = sIdx === activeSectionIdx;
          return (
            <div className={`sop-section${sectionComplete ? ' sop-section-done' : isActive ? ' sop-section-active' : ''}`} key={section.key || section.title}>
              <div className="sop-section-header">
                <span className="sop-section-emoji">
                  {sectionComplete ? <CheckSquare size={16} /> : section.emoji || <Square size={16} />}
                </span>
                <span className="sop-section-title">{section.title}</span>
                <span className="sop-section-time muted">{section.time}</span>
                <span className={`sop-section-count${sectionComplete ? ' positive' : ' muted'}`}>
                  {sectionDone}/{section.items.length}
                </span>
                {sectionComplete && <span className="sop-section-badge">Done</span>}
              </div>
              <ul className="sop-list">
                {section.items.map((item, iIdx) => {
                  const done = !!checked[item.key];
                  return (
                    <li
                      key={item.key || iIdx}
                      className={`sop-item${done ? ' sop-done' : ''}`}
                      onClick={() => toggle(item.key)}
                    >
                      {done ? <CheckSquare size={15} className="positive" /> : <Square size={15} className="muted" />}
                      <span>{item.text}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <h3>Quick Reference</h3>
          <span className="badge muted">New CAM onboarding</span>
        </div>
        <div className="sop-ref-grid">
          <div className="sop-ref-card">
            <div className="sop-ref-title">Connections & Data</div>
            <ol className="sop-ref-steps">
              <li>Confirm charts are moving properly.</li>
              <li>Check for delayed-data indicators.</li>
              <li>If delayed, disconnect all prop-firm connections.</li>
              <li>Reconnect one connection at a time to isolate the issue.</li>
            </ol>
          </div>
          <div className="sop-ref-card">
            <div className="sop-ref-title">Algo Configuration</div>
            <ol className="sop-ref-steps">
              <li>Verify instrument, current contract, and timeframe.</li>
              <li>Check for rollover needs before enabling algos.</li>
              <li>Confirm no duplicated algos are running.</li>
              <li>Log any changes in client activity.</li>
            </ol>
          </div>
          <div className="sop-ref-card">
            <div className="sop-ref-title">Accounts</div>
            <ol className="sop-ref-steps">
              <li>Verify all accounts are assigned to the right client.</li>
              <li>Funded accounts stay active unless agreed as reserves.</li>
              <li>Review balances and account status daily.</li>
              <li>Update notes if account handling differs from normal flow.</li>
            </ol>
          </div>
          <div className="sop-ref-card">
            <div className="sop-ref-title">Payout & Evaluation Levels</div>
            <ol className="sop-ref-steps">
              <li>Flag payout-level funded accounts at 54k.</li>
              <li>Flag passed evaluations at 53k.</li>
              <li>Within $300-$500 of payout, reduce to one algo.</li>
              <li>Recommend OGX on a low-risk setting near payout.</li>
            </ol>
          </div>
        </div>
      </section>
    </div>
  );
}
