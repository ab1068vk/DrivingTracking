import { useState } from 'react';
import { Plus } from 'lucide-react';
import { SectionTitle } from './settingsComponents';
import { PrivacyZoneDialog } from './privacy-zones/PrivacyZoneDialog';
import { PrivacyZoneInfoCard } from './privacy-zones/PrivacyZoneInfoCard';
import { PrivacyZoneList } from './privacy-zones/PrivacyZoneList';
import { usePrivacyZones } from './privacy-zones/usePrivacyZones';

function editingMode(editingIndex) {
  return Number.isInteger(editingIndex) ? 'edit' : 'add';
}

export function PrivacyZonesSettings() {
  const { addZone, deleteZone, loading, updateZone, zones } = usePrivacyZones();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState(null);
  const activeZone = Number.isInteger(editingIndex) ? zones[editingIndex] : null;

  const closeDialog = (open) => {
    setDialogOpen(open);
    if (!open) setEditingIndex(null);
  };

  const openAddDialog = () => {
    setEditingIndex(null);
    setDialogOpen(true);
  };

  const openEditDialog = (index) => {
    setEditingIndex(index);
    setDialogOpen(true);
  };

  const saveZone = async (zone) => {
    if (Number.isInteger(editingIndex)) {
      await updateZone(editingIndex, zone);
      return;
    }
    await addZone(zone);
  };

  const confirmDeleteZone = async (index) => {
    const zone = zones[index];
    if (!zone || !confirm(`Delete ${zone.name} privacy zone?`)) return;
    await deleteZone(index);
  };

  return (
    <div className="space-y-4">
      <SectionTitle id="settings-privacy-zones">Parked Privacy Zones</SectionTitle>

      <PrivacyZoneInfoCard />

      <div className="rounded-2xl border border-border bg-secondary/30 p-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Privacy zones</h3>
            <p className="mt-1 text-xs text-muted-foreground">Saved to Android Preferences for parked-car privacy.</p>
          </div>
          <button
            type="button"
            onClick={openAddDialog}
            className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-xl bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
            Add zone
          </button>
        </div>

        <PrivacyZoneList
          loading={loading}
          zones={zones}
          onDelete={confirmDeleteZone}
          onEdit={openEditDialog}
        />
      </div>

      <PrivacyZoneDialog
        mode={editingMode(editingIndex)}
        open={dialogOpen}
        zone={activeZone}
        onOpenChange={closeDialog}
        onSave={saveZone}
      />
    </div>
  );
}

export default PrivacyZonesSettings;
