import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { tripService } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import { Car, Plus, Pencil, Trash2, Check, Star, X } from 'lucide-react';
import VehicleCompare from '@/components/VehicleCompare';

const COLORS = ['#ef4444','#f97316','#eab308','#22c55e','#3b82f6','#8b5cf6','#ec4899','#6b7280'];

function VehicleForm({ initial = {}, onSave, onCancel }) {
  const [form, setForm] = useState({ name: '', make: '', model: '', year: '', color: '#3b82f6', plate: '', ...initial });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div className="bg-secondary/50 rounded-2xl p-4 space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div className="col-span-2">
          <label className="text-xs text-muted-foreground mb-1 block">Nickname *</label>
          <input
            value={form.name} onChange={e => set('name', e.target.value)}
            placeholder="e.g. My Tesla"
            className="w-full px-3 py-2 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Make</label>
          <input value={form.make} onChange={e => set('make', e.target.value)} placeholder="Toyota"
            className="w-full px-3 py-2 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Model</label>
          <input value={form.model} onChange={e => set('model', e.target.value)} placeholder="Corolla"
            className="w-full px-3 py-2 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Year</label>
          <input value={form.year} onChange={e => set('year', e.target.value)} placeholder="2022" type="number"
            className="w-full px-3 py-2 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Plate</label>
          <input value={form.plate} onChange={e => set('plate', e.target.value.toUpperCase())} placeholder="ABC 123"
            className="w-full px-3 py-2 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary" />
        </div>
      </div>
      <div>
        <label className="text-xs text-muted-foreground mb-1.5 block">Color</label>
        <div className="flex gap-2 flex-wrap">
          {COLORS.map(c => (
            <button key={c} onClick={() => set('color', c)}
              className="w-7 h-7 rounded-full border-2 transition-all"
              style={{ background: c, borderColor: form.color === c ? 'white' : 'transparent', outline: form.color === c ? `2px solid ${c}` : 'none' }}
            />
          ))}
        </div>
      </div>
      <div className="flex gap-2">
        <button onClick={onCancel} className="flex-1 py-2 border border-border rounded-xl text-sm font-medium hover:bg-secondary transition-colors flex items-center justify-center gap-1.5">
          <X className="w-3.5 h-3.5" /> Cancel
        </button>
        <button
          onClick={() => form.name.trim() && onSave(form)}
          disabled={!form.name.trim()}
          className="flex-1 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:opacity-90 transition-opacity flex items-center justify-center gap-1.5 disabled:opacity-40"
        >
          <Check className="w-3.5 h-3.5" /> Save
        </button>
      </div>
    </div>
  );
}

export default function Vehicles() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);

  const { data: vehicles = [], isLoading } = useQuery({
    queryKey: ['vehicles'],
    queryFn: () => vehicleService.list({ sort: '-created_date', limit: 50 }),
  });

  const { data: trips = [] } = useQuery({
    queryKey: ['all-trips-vehicles'],
    queryFn: () => tripService.list({ sort: '-start_time', limit: 500 }),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['vehicles'] });

  const createMut = useMutation({
    mutationFn: (d) => vehicleService.create(d),
    onSuccess: () => { invalidate(); setShowAdd(false); },
  });

  const updateMut = useMutation({
    mutationFn: ({ id, d }) => vehicleService.update(id, d),
    onSuccess: () => { invalidate(); setEditId(null); },
  });

  const deleteMut = useMutation({
    mutationFn: (id) => vehicleService.delete(id),
    onSuccess: invalidate,
  });

  const handleSetDefault = async (id) => {
    for (const v of vehicles) {
      await vehicleService.update(v.id, { is_default: v.id === id });
    }
    invalidate();
  };

  const tripCountFor = (vehicleId) => trips.filter(t => t.vehicle_id === vehicleId && t.status === 'completed').length;
  const avgScoreFor = (vehicleId) => {
    const vTrips = trips.filter(t => t.vehicle_id === vehicleId && t.status === 'completed');
    if (!vTrips.length) return null;
    return Math.round(vTrips.reduce((s, t) => s + (t.score_overall || 0), 0) / vTrips.length);
  };

  return (
    <div className="space-y-5 pb-6">
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-grotesk font-bold">My Vehicles</h1>
          <p className="text-muted-foreground text-sm mt-1">Manage vehicles and track per-car stats</p>
        </div>
        <button
          onClick={() => setShowAdd(v => !v)}
          className="flex items-center gap-1.5 px-3 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:opacity-90 transition-opacity"
        >
          <Plus className="w-4 h-4" /> Add
        </button>
      </motion.div>

      <AnimatePresence>
        {showAdd && (
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
            <VehicleForm onSave={(d) => createMut.mutate(d)} onCancel={() => setShowAdd(false)} />
          </motion.div>
        )}
      </AnimatePresence>

      {isLoading && (
        <div className="space-y-3">
          {[1, 2].map(i => <div key={i} className="h-24 bg-secondary/50 rounded-2xl animate-pulse" />)}
        </div>
      )}

      {!isLoading && vehicles.length === 0 && !showAdd && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-16 h-16 bg-secondary rounded-3xl flex items-center justify-center mb-4">
            <Car className="w-8 h-8 text-muted-foreground" />
          </div>
          <div className="font-semibold mb-1">No vehicles yet</div>
          <div className="text-muted-foreground text-sm">Add your first vehicle to track stats per car</div>
        </div>
      )}

      {vehicles.length >= 2 && (
        <VehicleCompare vehicles={vehicles} trips={trips} />
      )}

      <div className="space-y-3">
        {vehicles.map((v, i) => {
          const count = tripCountFor(v.id);
          const score = avgScoreFor(v.id);
          const isEditing = editId === v.id;

          return (
            <motion.div key={v.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}
              className="bg-card border border-border rounded-2xl overflow-hidden">
              {isEditing ? (
                <div className="p-4">
                  <VehicleForm
                    initial={v}
                    onSave={(d) => updateMut.mutate({ id: v.id, d })}
                    onCancel={() => setEditId(null)}
                  />
                </div>
              ) : (
                <div className="p-4">
                  <div className="flex items-start gap-3">
                    {/* Color dot */}
                    <div className="w-11 h-11 rounded-2xl flex items-center justify-center flex-shrink-0 mt-0.5"
                      style={{ background: v.color || '#3b82f6' }}>
                      <Car className="w-5 h-5 text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm">{v.name}</span>
                        {v.is_default && (
                          <span className="text-xs bg-amber-50 dark:bg-amber-950/30 text-amber-600 border border-amber-200 dark:border-amber-800/50 px-1.5 py-0.5 rounded-full">
                            ★ Default
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {[v.year, v.make, v.model].filter(Boolean).join(' ') || 'No details'}
                        {v.plate && <span className="ml-1.5 bg-secondary px-1.5 py-0.5 rounded font-mono">{v.plate}</span>}
                      </div>
                      <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                        <span>{count} trip{count !== 1 ? 's' : ''}</span>
                        {score !== null && (
                          <span className="font-semibold text-primary">Avg score: {score}</span>
                        )}
                      </div>
                    </div>
                    {/* Actions */}
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <button onClick={() => handleSetDefault(v.id)} title="Set as default"
                        className={`p-1.5 rounded-lg transition-colors ${v.is_default ? 'text-amber-500' : 'text-muted-foreground hover:bg-secondary'}`}>
                        <Star className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => setEditId(v.id)}
                        className="p-1.5 text-muted-foreground hover:bg-secondary rounded-lg transition-colors">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => deleteMut.mutate(v.id)}
                        className="p-1.5 text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 rounded-lg transition-colors">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
