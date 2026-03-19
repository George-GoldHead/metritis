import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Clock, ClipboardPaste } from 'lucide-react';
import * as XLSX from 'xlsx';
import TopBar from '../components/energy/TopBar';
import TabBar from '../components/energy/TabBar';
import Sidebar from '../components/energy/Sidebar';
import SummaryCards from '../components/energy/SummaryCards';
import ProviderPeriodSelector from '../components/energy/ProviderPeriodSelector';
import MonthCard from '../components/energy/MonthCard';
import ReadingModal from '../components/energy/ReadingModal';
import SettingsModal from '../components/energy/SettingsModal';
import InfoModal from '../components/energy/InfoModal';
import ChartsPanel from '../components/energy/ChartsPanel';

export default function DashboardV2() {
  const [activeTab, setActiveTab] = useState('gas');
  const [isDark, setIsDark] = useState(true);
  const [showTime, setShowTime] = useState({ gas: false, elec: false });
  const [addModal, setAddModal] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [chartsOpen, setChartsOpen] = useState(false);
  const [pendingDel, setPendingDel] = useState(null);
  const [periodStart, setPeriodStart] = useState({ gas: '', elec: '' });
  const [periodEnd, setPeriodEnd] = useState({ gas: '', elec: '' });
  const [settings, setSettings] = useState({});
  const importFileRef = useRef(null);

  // --- NEW STATES FOR IMPORT ---
  const [pasteModalOpen, setPasteModalOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [importYear, setImportYear] = useState(new Date().getFullYear());
  const [previewData, setPreviewData] = useState(null);
  const [isImporting, setIsImporting] = useState(false);

  const queryClient = useQueryClient();

  // Load settings
  useEffect(() => {
    base44.auth.me().then(user => {
      if (user.energy_settings) setSettings(user.energy_settings);
      if (user.energy_theme === 'light') {
        setIsDark(false);
        document.documentElement.setAttribute('data-theme', 'light');
      }
    }).catch(() => {});
  }, []);

  const toggleTheme = useCallback(() => {
    const newDark = !isDark;
    setIsDark(newDark);
    document.documentElement.setAttribute('data-theme', newDark ? 'dark' : 'light');
    base44.auth.updateMe({ energy_theme: newDark ? 'dark' : 'light' }).catch(() => {});
  }, [isDark]);

  const { data: gasReadings = [], isLoading: gasLoading } = useQuery({
    queryKey: ['gasReadings'],
    queryFn: () => base44.entities.GasReading.list('-date', 1000), // Αυξημένο limit για παλιά έτη
  });

  const { data: elecReadings = [], isLoading: elecLoading } = useQuery({
    queryKey: ['elecReadings'],
    queryFn: () => base44.entities.ElecReading.list('-date', 1000),
  });

  const readings = activeTab === 'gas' ? gasReadings : elecReadings;
  const isLoading = activeTab === 'gas' ? gasLoading : elecLoading;
  const entityName = activeTab === 'gas' ? 'GasReading' : 'ElecReading';
  const unit = activeTab === 'gas' ? 'm³' : 'kWh';

  const sorted = useMemo(() =>
    [...readings].sort((a, b) => {
      const da = new Date(a.date + 'T' + (a.time || '08:00'));
      const db = new Date(b.date + 'T' + (b.time || '08:00'));
      return da - db;
    }),
    [readings]
  );

  const withDiff = useMemo(() =>
    sorted.map((item, i) => ({
      ...item,
      diff: +(item.reading - (i > 0 ? sorted[i - 1].reading : item.reading)).toFixed(3),
    })),
    [sorted]
  );

  const providerReadings = useMemo(() => sorted.filter(x => x.is_provider), [sorted]);
  const startId = periodStart[activeTab] || (providerReadings.length >= 2 ? providerReadings[providerReadings.length - 2]?.id : sorted[0]?.id) || '';
  const endId = periodEnd[activeTab] || (providerReadings.length >= 1 ? providerReadings[providerReadings.length - 1]?.id : sorted[sorted.length - 1]?.id) || '';

  const providerTotal = useMemo(() => {
    const startItem = sorted.find(x => x.id === startId);
    const endItem = sorted.find(x => x.id === endId);
    if (startItem && endItem) return +(endItem.reading - startItem.reading).toFixed(3);
    return 0;
  }, [sorted, startId, endId]);

  const providerLabel = useMemo(() => {
    const s = sorted.find(x => x.id === startId);
    const e = sorted.find(x => x.id === endId);
    if (!s || !e) return '—';
    const sd = new Date(s.date), ed = new Date(e.date);
    return `${sd.getDate()}/${sd.getMonth() + 1} → ${ed.getDate()}/${ed.getMonth() + 1}`;
  }, [sorted, startId, endId]);

  const curYear = new Date().getFullYear();
  const yearTotal = useMemo(() => {
    const yearItems = withDiff.filter(x => new Date(x.date).getFullYear() === curYear);
    if (yearItems.length > 1) return +(yearItems[yearItems.length - 1].reading - yearItems[0].reading).toFixed(3);
    return 0;
  }, [withDiff, curYear]);

  const yearGroups = useMemo(() => {
    const groups = {};
    withDiff.forEach(item => {
      const dt = new Date(item.date);
      const yr = dt.getFullYear();
      const mk = `${yr}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
      const mlabel = dt.toLocaleString('el-GR', { month: 'long' });
      if (!groups[yr]) groups[yr] = {};
      if (!groups[yr][mk]) groups[yr][mk] = { label: mlabel, items: [] };
      groups[yr][mk].items.push(item);
    });
    return groups;
  }, [withDiff]);

  // --- IMPORT LOGIC ---
  const handleProcessPaste = () => {
    const lines = pasteText.split('\n');
    const parsed = [];
    lines.forEach((line, index) => {
      const columns = line.split('\t');
      let rawDate = columns[0]?.trim();
      let rawReading = columns[1]?.trim();
      if (rawDate && rawDate.includes('/') && rawReading) {
        parsed.push({
          id: index,
          rawDate,
          rawReading: rawReading.replace(',', '.'),
          isProvider: false 
        });
      }
    });
    if (parsed.length > 0) {
      setPreviewData(parsed);
      setPasteText('');
    } else {
      alert("Δεν βρέθηκαν δεδομένα. Επιλέξτε τις στήλες 'Ημερομηνία' και 'Ένδειξη' από το Excel.");
    }
  };

  const confirmImport = async () => {
    if (!previewData) return;
    setIsImporting(true);
    try {
      const finalRows = previewData.map(row => {
        const [d, m] = row.rawDate.split('/');
        return {
          date: `${importYear}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`,
          reading: parseFloat(row.rawReading),
          time: '08:00',
          is_provider: !!row.isProvider
        };
      });
      await base44.entities[entityName].bulkCreate(finalRows);
      queryClient.invalidateQueries({ queryKey: [activeTab + 'Readings'] });
      setPreviewData(null);
      setPasteModalOpen(false);
      alert("Επιτυχής εισαγωγή!");
    } catch (error) {
      alert("Σφάλμα κατά την αποθήκευση.");
    } finally {
      setIsImporting(false);
    }
  };

  // Mutations
  const createMutation = useMutation({
    mutationFn: (data) => base44.entities[entityName].create(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [activeTab + 'Readings'] }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => base44.entities[entityName].update(id, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [activeTab + 'Readings'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => base44.entities[entityName].delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [activeTab + 'Readings'] }),
  });

  const handleSaveReading = (data) => {
    if (editItem) updateMutation.mutate({ id: editItem.id, data });
    else createMutation.mutate(data);
    setAddModal(false);
    setEditItem(null);
  };

  const handleDelete = useCallback((id) => {
    if (pendingDel === id) {
      deleteMutation.mutate(id);
      setPendingDel(null);
    } else {
      setPendingDel(id);
      setTimeout(() => setPendingDel(prev => prev === id ? null : prev), 2000);
    }
  }, [pendingDel, deleteMutation]);

  const handleEdit = (item) => {
    setEditItem(item);
    setAddModal(true);
  };

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] transition-colors flex">
      <Sidebar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        isDark={isDark}
        onToggleTheme={toggleTheme}
        onCharts={() => setChartsOpen(true)}
        onSettings={() => setSettingsOpen(true)}
        onInfo={() => setInfoOpen(true)}
        onExportCSV={() => {}} // Κράτησε το παλιό export αν θες
        onImportExcel={() => setPasteModalOpen(true)} // Εδώ ανοίγει το Paste
        showTime={showTime[activeTab]}
        onToggleTime={() => setShowTime(prev => ({ ...prev, [activeTab]: !prev[activeTab] }))}
        fileRef={importFileRef}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <div className="lg:hidden">
          <TopBar isDark={isDark} onToggleTheme={toggleTheme} onCharts={() => setChartsOpen(true)} onSettings={() => setSettingsOpen(true)} onInfo={() => setInfoOpen(true)} onExportCSV={() => {}} onImportExcel={() => setPasteModalOpen(true)} />
          <TabBar activeTab={activeTab} onTabChange={setActiveTab} />
        </div>

        <div className="hidden lg:flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
          <span className={`font-mono text-xl font-bold tracking-wider ${activeTab === 'gas' ? 'text-orange-500' : 'text-blue-500'}`}>
            {activeTab === 'gas' ? '🔥 Αέριο' : '⚡ Ρεύμα'}
          </span>
          <button 
             onClick={() => setPasteModalOpen(true)}
             className="flex items-center gap-2 text-xs font-mono bg-[var(--surface)] border border-[var(--border)] px-3 py-1.5 rounded-lg hover:border-[var(--text)] transition-all"
          >
            <ClipboardPaste className="w-4 h-4" /> Επικόλληση από Excel
          </button>
        </div>

        <div className="w-full px-4 lg:px-6 pt-4 pb-24 lg:pb-8 flex-1">
          <SummaryCards tab={activeTab} providerTotal={providerTotal} providerLabel={providerLabel} yearTotal={yearTotal} yearLabel={`έτος ${curYear}`} />
          <ProviderPeriodSelector readings={sorted} startId={startId} endId={endId} onStartChange={(v) => setPeriodStart(prev => ({ ...prev, [activeTab]: v }))} onEndChange={(v) => setPeriodEnd(prev => ({ ...prev, [activeTab]: v }))} />

          {isLoading ? (
            <div className="flex items-center justify-center py-20">
              <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin" />
            </div>
          ) : sorted.length === 0 ? (
            <div className="text-center text-[var(--muted)] font-mono text-sm leading-[2.2] py-16">Δεν υπάρχουν μετρήσεις.</div>
          ) : (
            Object.keys(yearGroups).sort((a, b) => b - a).map(yr => {
              const months = yearGroups[yr];
              const monthKeys = Object.keys(months).sort();
              const yrItems = Object.values(months).flatMap(m => m.items).sort((a, b) => new Date(a.date) - new Date(b.date));
              const yrTotalValue = yrItems.length > 1 ? (yrItems[yrItems.length - 1].reading - yrItems[0].reading).toFixed(3) : '0.000';
              const yearColor = activeTab === 'gas' ? 'text-orange-500' : 'text-blue-500';

              return (
                <div key={yr} className="mb-7">
                  <div className="flex items-center gap-3 mb-3.5">
                    <span className={`font-mono text-base font-semibold tracking-widest ${yearColor}`}>{yr}</span>
                    <span className={`font-mono text-base font-semibold bg-[var(--surface)] border border-[var(--border)] px-2.5 py-0.5 rounded-full whitespace-nowrap ${yearColor}`}>
                      {activeTab === 'gas' ? '🔥' : '⚡'} {yrTotalValue} {unit}
                    </span>
                    <div className="flex-1 h-px bg-[var(--border)]" />
                  </div>
                  <div className="flex flex-row gap-3 overflow-x-auto pb-3 snap-x snap-mandatory" style={{ WebkitOverflowScrolling: 'touch' }}>
                    {monthKeys.map(mk => (
                      <MonthCard key={mk} label={months[mk].label} items={months[mk].items} unit={unit} tab={activeTab} showTime={showTime[activeTab]} onDelete={handleDelete} onEdit={handleEdit} pendingDel={pendingDel} />
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <button onClick={() => { setEditItem(null); setAddModal(true); }} className={`fixed bottom-6 right-5 w-14 h-14 rounded-full border-none text-2xl cursor-pointer flex items-center justify-center z-40 transition-transform active:scale-90 ${activeTab === 'gas' ? 'bg-orange-500 shadow-[0_4px_24px_rgba(249,115,22,0.4)]' : 'bg-blue-500 shadow-[0_4px_24px_rgba(59,130,246,0.4)]'} text-white`}>
        <Plus className="w-7 h-7" />
      </button>

      {/* --- MODALS --- */}
      <ReadingModal open={addModal} onClose={() => { setAddModal(false); setEditItem(null); }} onSave={handleSaveReading} tab={activeTab} editData={editItem} />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} settings={settings} onSave={(data) => { setSettings(data); setSettingsOpen(false); }} />
      <InfoModal open={infoOpen} onClose={() => setInfoOpen(false)} />
      <ChartsPanel open={chartsOpen} onClose={() => setChartsOpen(false)} gasReadings={gasReadings} elecReadings={elecReadings} />

      {/* --- NEW PASTE & PREVIEW MODALS --- */}
      {pasteModalOpen && !previewData && (
        <div className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-[#1a1d24] border border-slate-700 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-200 text-white">
            <div className="p-5 border-b border-slate-700 bg-slate-900/50 flex justify-between items-center">
              <h3 className="font-bold text-lg">Επικόλληση {activeTab === 'gas' ? 'Αερίου' : 'Ρεύματος'}</h3>
              <button onClick={() => setPasteModalOpen(false)}>✕</button>
            </div>
            <div className="p-6">
              <textarea
                autoFocus
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder="Επικολλήστε τις 2 στήλες από το Excel εδώ..."
                className="w-full h-48 bg-[#0f1115] border border-slate-700 rounded-xl p-4 text-white font-mono text-sm outline-none focus:border-orange-500 transition-all resize-none"
              />
            </div>
            <div className="p-5 bg-slate-900/30 flex gap-3">
              <button onClick={handleProcessPaste} className={`flex-1 py-3 rounded-xl font-bold ${activeTab === 'gas' ? 'bg-orange-500' : 'bg-blue-500'}`}>Επεξεργασία</button>
              <button onClick={() => setPasteModalOpen(false)} className="px-6 text-slate-400">Άκυρο</button>
            </div>
          </div>
        </div>
      )}

      {previewData && (
        <div className="fixed inset-0 z-[110] bg-black/90 flex items-center justify-center p-4 backdrop-blur-md">
          <div className="bg-[#1a1d24] border border-slate-700 rounded-2xl w-full max-w-md shadow-2xl flex flex-col max-h-[90vh] text-white">
            <div className="p-5 border-b border-slate-700 bg-slate-900/50">
              <h3 className="font-bold text-lg mb-2">Προεπισκόπηση</h3>
              <div className="bg-black/40 p-3 rounded-xl border border-slate-800">
                <label className="text-[10px] text-slate-500 uppercase block mb-1">Έτος</label>
                <input type="number" value={importYear} onChange={(e) => setImportYear(e.target.value)} className="w-full bg-transparent text-white font-mono text-xl outline-none" />
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-[#0f1115]">
              <table className="w-full text-xs font-mono">
                <thead className="bg-slate-900 sticky top-0">
                  <tr>
                    <th className="p-3 text-left text-slate-500">Ημ/νία</th>
                    <th className="p-3 text-right text-slate-500">Ένδειξη</th>
                    <th className="p-3 text-center text-slate-500">P</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {previewData.map((row, idx) => (
                    <tr key={idx}>
                      <td className="p-3">{row.rawDate}</td>
                      <td className="p-3 text-right text-emerald-400 font-bold">{row.rawReading}</td>
                      <td className="p-3 text-center">
                        <input type="checkbox" checked={row.isProvider} onChange={(e) => {
                          const next = [...previewData];
                          next[idx].isProvider = e.target.checked;
                          setPreviewData(next);
                        }} className="w-4 h-4" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="p-5 bg-slate-900/50 border-t border-slate-700 flex gap-3">
              <button onClick={confirmImport} disabled={isImporting} className="flex-1 bg-emerald-600 py-3 rounded-xl font-bold disabled:opacity-50">
                {isImporting ? 'Αποθήκευση...' : `Ολοκλήρωση (${previewData.length})`}
              </button>
              <button onClick={() => setPreviewData(null)} className="px-6 text-slate-400">Πίσω</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
