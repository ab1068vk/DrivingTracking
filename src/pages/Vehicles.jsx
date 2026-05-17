import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { tripService } from '@/api/trips';
import { vehicleService } from '@/api/vehicles';
import { Car, Plus, Pencil, Trash2, Check, Star, X, Wrench, Fuel, Activity, AlertTriangle } from 'lucide-react';
import VehicleCompare from '@/components/VehicleCompare';
import { calculatePredictiveMaintenance, calculateVehicleHealthImpact, estimateTripEconomics, getMaintenanceStatus, getVehicleOdometerKm } from '@/lib/tripInsights';

const COLORS = ['#ef4444','#f97316','#eab308','#22c55e','#3b82f6','#8b5cf6','#ec4899','#6b7280'];

function VehicleForm({ initial = {}, onSave, onCancel }) {
  const [form, setForm] = useState({
    name: '',
    make: '',
    model: '',
    year: '',
    color: '#3b82f6',
    plate: '',
    odometer_km: 0,
    fuel_efficiency_l_per_100km: 8.5,
    fuel_price_per_liter: 1.65,
    ...initial,
  });
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
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Odometer (km)</label>
          <input value={form.odometer_km} onChange={e => set('odometer_km', e.target.value)} placeholder="42000" type="number"
            className="w-full px-3 py-2 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Fuel L/100km</label>
          <input value={form.fuel_efficiency_l_per_100km} onChange={e => set('fuel_efficiency_l_per_100km', e.target.value)} placeholder="8.5" type="number" step="0.1"
            className="w-full px-3 py-2 bg-card border border-border rounded-xl text-sm outline-none focus:border-primary" />
        </div>
        <div className="col-span-2">
          <label className="text-xs text-muted-foreground mb-1 block">Fuel Price ($/L)</label>
          <input value={form.fuel_price_per_liter} onChange={e => set('fuel_price_per_liter', e.target.value)} placeholder="1.65" type="number" step="0.01"
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
          onClick={() => form.name.trim() && onSave({
            ...form,
            odometer_km: Number(form.odometer_km) || 0,
            fuel_efficiency_l_per_100km: Number(form.fuel_efficiency_l_per_100km) || 8.5,
            fuel_price_per_liter: Number(form.fuel_price_per_liter) || 1.65,
          })}
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
    mutationFn: (/** @type {any} */ d) => vehicleService.create(d),
    onSuccess: () => { invalidate(); setShowAdd(false); },
  });

  const updateMut = useMutation({
    mutationFn: (/** @type {{id:any,d:any}} */ vars) => vehicleService.update(vars.id, vars.d),
    onSuccess: () => { invalidate(); setEditId(null); },
  });

  const deleteMut = useMutation({
    mutationFn: (/** @type {any} */ id) => vehicleService.delete(id),
    onSuccess: invalidate,
  });

  const handleSetDefault = async (id) => {
    for (const v of vehicles) {
      await vehicleService.update(v.id, { is_default: v.id === id });
    }
    invalidate();
  };

  const handleServiceDone = async (vehicle, item, odometerKm) => {
    const items = getMaintenanceStatus(vehicle, trips).map((entry) => (
      entry.id === item.id
        ? { ...entry, last_service_km: odometerKm }
        : entry
    ));
    await vehicleService.update(vehicle.id, { maintenance_items: items });
    invalidate();
  };

  const tripListFor = (vehicle) => trips.filter(t => (
    t.status === 'completed' &&
    (t.vehicle_id === vehicle.id || (vehicle.is_default && !t.vehicle_id))
  ));
  const tripCountFor = (vehicle) => tripListFor(vehicle).length;
  const avgScoreFor = (vehicle) => {
    const vTrips = tripListFor(vehicle);
    if (!vTrips.length) return null;
    return Math.round(vTrips.reduce((s, t) => s + (t.score_overall || 0), 0) / vTrips.length);
  };
  const fuelTotalsFor = (vehicle) => tripListFor(vehicle).reduce((totals, trip) => {
    const estimate = estimateTripEconomics(trip, vehicle);
    return {
      cost: totals.cost + estimate.cost,
      co2: totals.co2 + estimate.co2_kg,
    };
  }, { cost: 0, co2: 0 });

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
        <div className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-border bg-card py-16 px-4 text-center">
          <div className="w-16 h-16 bg-secondary rounded-3xl flex items-center justify-center mb-4">
            <Car className="w-8 h-8 text-muted-foreground" />
          </div>
          <div className="font-semibold mb-1">No vehicles yet</div>
          <div className="max-w-xs text-muted-foreground text-sm">Add your first vehicle to connect trips with fuel cost, maintenance, odometer, and per-car scores.</div>
          <button
            onClick={() => setShowAdd(true)}
            className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
          >
            <Plus className="h-4 w-4" />
            Add vehicle
          </button>
        </div>
      )}

      {vehicles.length >= 2 && (
        <VehicleCompare vehicles={vehicles} trips={trips} />
      )}

      <div className="space-y-3">
        {vehicles.map((v, i) => {
          const count = tripCountFor(v);
          const score = avgScoreFor(v);
          const isEditing = editId === v.id;
          const odometerKm = getVehicleOdometerKm(v, trips);
          const vehicleTrips = tripListFor(v);
          const predictiveMaintenance = calculatePredictiveMaintenance(vehicleTrips, v, {});
          const stressLabel = predictiveMaintenance.stress_index > 0.6
            ? 'High'
            : predictiveMaintenance.stress_index > 0.3
              ? 'Moderate'
              : 'Low';
          const maintenance = getMaintenanceStatus(v, trips);
          const dueMaintenance = maintenance.filter((item) => item.status !== 'ok');
          const fuelTotals = fuelTotalsFor(v);
          const healthImpact = calculateVehicleHealthImpact(tripListFor(v), v);
          const avgEngineStress = vehicleTrips.length
            ? Math.round(vehicleTrips.reduce((sum, trip) => sum + (trip.engine_stress_score ?? 100), 0) / vehicleTrips.length)
            : null;

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
                        <span className={`text-xs border px-1.5 py-0.5 rounded-full ${
                          stressLabel === 'High'
                            ? 'bg-red-50 text-red-600 border-red-200 dark:bg-red-950/30 dark:border-red-800/50'
                            : stressLabel === 'Moderate'
                              ? 'bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-950/30 dark:border-yellow-800/50'
                              : 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-800/50'
                        }`}>
                          {stressLabel} stress
                        </span>
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
                        <span>{odometerKm.toLocaleString()} km</span>
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
                  <div className="grid grid-cols-2 gap-2 mt-4">
                    <div className="bg-secondary/50 rounded-xl p-3">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Fuel className="w-3.5 h-3.5" />
                        Fuel estimate
                      </div>
                      <div className="font-semibold text-sm mt-1">${fuelTotals.cost.toFixed(2)}</div>
                      <div className="text-xs text-muted-foreground">{fuelTotals.co2.toFixed(1)} kg CO2</div>
                    </div>
                    <div className="bg-secondary/50 rounded-xl p-3">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Wrench className="w-3.5 h-3.5" />
                        Maintenance
                      </div>
                      <div className={`font-semibold text-sm mt-1 ${dueMaintenance.length ? 'text-orange-500' : 'text-emerald-500'}`}>
                        {dueMaintenance.length ? `${dueMaintenance.length} due soon` : 'All good'}
                      </div>
                      <div className="text-xs text-muted-foreground">{v.fuel_efficiency_l_per_100km || 8.5} L/100km</div>
                    </div>
                    <div className="bg-secondary/50 rounded-xl p-3">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Activity className="w-3.5 h-3.5" />
                        Driving impact
                      </div>
                      <div className={`font-semibold text-sm mt-1 ${
                        healthImpact.health_grade === 'A' ? 'text-emerald-500' : healthImpact.health_grade === 'B' ? 'text-blue-500' : 'text-orange-500'
                      }`}>
                        Grade {healthImpact.health_grade}
                      </div>
                      <div className="text-xs text-muted-foreground">{healthImpact.extra_wear_km.toLocaleString()} extra wear km</div>
                    </div>
                    <div className="bg-secondary/50 rounded-xl p-3">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Wrench className="w-3.5 h-3.5" />
                        Adjusted service
                      </div>
                      <div className="font-semibold text-sm mt-1">{healthImpact.adjusted_oil_change_km.toLocaleString()} km oil</div>
                      <div className="text-xs text-muted-foreground">{healthImpact.aggressive_ratio}% aggressive km</div>
                    </div>
                    <div className="bg-secondary/50 rounded-xl p-3">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Activity className="w-3.5 h-3.5" />
                        Engine stress
                      </div>
                      <div className="font-semibold text-sm mt-1">{avgEngineStress ?? '-'} score</div>
                      <div className="text-xs text-muted-foreground">High-speed acceleration adds engine and transmission wear.</div>
                    </div>
                    <div className="bg-secondary/50 rounded-xl p-3">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <AlertTriangle className={`w-3.5 h-3.5 ${
                          ['elevated', 'accelerated'].includes(healthImpact.tire_wear_grade) ? 'text-yellow-500' : ''
                        }`} />
                        Tire wear impact
                      </div>
                      <div className="font-semibold text-sm mt-1 capitalize">{healthImpact.tire_wear_grade}</div>
                      <div className="text-xs text-muted-foreground">{healthImpact.tire_life_impact_km.toLocaleString()} km estimated tire life reduction</div>
                    </div>
                  </div>

                  <div className="space-y-2 mt-3">
                    {maintenance.map((item) => {
                      const predictive = item.id === 'oil'
                        ? predictiveMaintenance.oil_change
                        : item.id === 'tires'
                          ? predictiveMaintenance.tire_rotation
                          : predictiveMaintenance.inspection;
                      const adjustedFrom = Math.abs((predictive.urgency_delta || 0));
                      return (
                        <div key={item.id} className="flex items-center justify-between gap-3 text-xs border border-border rounded-xl p-2">
                          <div className="min-w-0">
                            <div className="font-medium">{item.label}</div>
                            <div className={`mt-0.5 ${
                              predictive.status === 'due' ? 'text-red-500' : predictive.status === 'soon' ? 'text-orange-500' : 'text-muted-foreground'
                            }`}>
                              {predictive.status === 'due'
                                ? `${Math.abs(predictive.remaining_km).toLocaleString()} km overdue`
                                : `${predictive.remaining_km.toLocaleString()} km left`}
                            </div>
                            <div className="mt-0.5 text-[11px] text-muted-foreground">
                              Adjusted {predictive.adjusted_interval_km.toLocaleString()} km from {item.interval_km.toLocaleString()} km{adjustedFrom ? ` (${adjustedFrom.toLocaleString()} km sooner)` : ''}
                            </div>
                          </div>
                          <button
                            onClick={() => handleServiceDone(v, item, odometerKm)}
                            className="px-2 py-1 rounded-lg bg-secondary text-muted-foreground hover:text-foreground whitespace-nowrap"
                          >
                            Done
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  {predictiveMaintenance.stress_index > 0.6 && (
                    <div className="mt-3 rounded-xl border border-yellow-200 bg-yellow-50 p-3 text-xs text-yellow-800 dark:border-yellow-800/50 dark:bg-yellow-950/30 dark:text-yellow-300">
                      Your aggressive driving style is accelerating wear. Smoother acceleration and earlier braking can stretch service intervals.
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
