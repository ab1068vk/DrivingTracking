const OBD_PID_DEFINITIONS = Object.freeze({
  '0C': {
    field: 'obd_rpm',
    label: 'RPM',
    unit: 'rpm',
    parse: (data) => data.length >= 2 ? ((data[0] * 256) + data[1]) / 4 : null,
  },
  '11': {
    field: 'obd_throttle_pct',
    label: 'Throttle',
    unit: '%',
    parse: (data) => data.length >= 1 ? Math.round((data[0] * 100) / 255) : null,
  },
  '04': {
    field: 'obd_engine_load_pct',
    label: 'Engine Load',
    unit: '%',
    parse: (data) => data.length >= 1 ? Math.round((data[0] * 100) / 255) : null,
  },
  '0D': {
    field: 'obd_speed_kmh',
    label: 'Vehicle Speed',
    unit: 'km/h',
    parse: (data) => data.length >= 1 ? data[0] : null,
  },
  '05': {
    field: 'obd_coolant_temp_c',
    label: 'Coolant Temp',
    unit: 'C',
    parse: (data) => data.length >= 1 ? data[0] - 40 : null,
  },
  '10': {
    field: 'obd_maf_gps',
    label: 'MAF',
    unit: 'g/s',
    parse: (data) => data.length >= 2 ? ((data[0] * 256) + data[1]) / 100 : null,
  },
});

export const OBD_ROUTE_POINT_FIELDS = Object.freeze(
  Object.values(OBD_PID_DEFINITIONS).map((definition) => definition.field)
);

export function parseObdPidResponse(raw = '') {
  const cleaned = String(raw).replace(/[>\r\n]/g, ' ').trim().toUpperCase();
  const bytes = cleaned.split(/\s+/).filter(Boolean);
  const modeIndex = bytes.findIndex((byte) => byte === '41');
  if (modeIndex < 0 || bytes.length < modeIndex + 3) return null;
  const pid = bytes[modeIndex + 1];
  const data = bytes.slice(modeIndex + 2).map((byte) => Number.parseInt(byte, 16));
  if (data.some((value) => !Number.isFinite(value))) return null;

  const definition = OBD_PID_DEFINITIONS[pid];
  if (definition) {
    const value = definition.parse(data);
    if (value == null || !Number.isFinite(value)) return null;
    return {
      pid,
      label: definition.label,
      value,
      unit: definition.unit,
      field: definition.field,
    };
  }
  return { pid, label: `PID ${pid}`, value: data[0] ?? null, unit: '' };
}

export function normalizeObdMeasurement(rawOrParsed, timestamp = new Date().toISOString()) {
  const parsed = typeof rawOrParsed === 'string'
    ? parseObdPidResponse(rawOrParsed)
    : rawOrParsed;
  if (!parsed || !parsed.field || !Number.isFinite(Number(parsed.value))) return null;
  return {
    pid: parsed.pid,
    label: parsed.label,
    field: parsed.field,
    value: Number(parsed.value),
    unit: parsed.unit || '',
    timestamp,
    source: 'obd_bluetooth',
  };
}

export function buildObdRoutePointPatch(measurements = [], timestamp = new Date().toISOString()) {
  const patch = {
    obd_data_source: 'obd_bluetooth',
    obd_data_timestamp: timestamp,
  };
  let accepted = 0;
  for (const item of Array.isArray(measurements) ? measurements : [measurements]) {
    const measurement = normalizeObdMeasurement(item, timestamp);
    if (!measurement) continue;
    patch[measurement.field] = measurement.value;
    patch.obd_data_timestamp = measurement.timestamp || timestamp;
    if (measurement.field === 'obd_speed_kmh') {
      patch.obd_speed_timestamp = measurement.timestamp || timestamp;
    }
    accepted++;
  }
  return accepted > 0 ? patch : {};
}

export function annotateRoutePointWithObd(routePoint = {}, measurements = [], timestamp = new Date().toISOString()) {
  const patch = buildObdRoutePointPatch(measurements, timestamp);
  return Object.keys(patch).length ? { ...routePoint, ...patch } : { ...routePoint };
}

export function getObdBluetoothSupport() {
  const nav = /** @type {any} */ (typeof navigator !== 'undefined' ? navigator : {});
  const supported = Boolean(nav.bluetooth);
  return {
    supported,
    transport: supported ? 'web_bluetooth_ble' : 'unavailable',
    note: supported
      ? 'Supports BLE OBD-II adapters that expose a writable/readable serial characteristic.'
      : 'This browser/WebView does not expose Web Bluetooth. Classic Bluetooth OBD-II requires a native plugin.',
  };
}

export function getObdBluetoothPermissionStatus() {
  const support = getObdBluetoothSupport();
  return {
    ...support,
    status: support.supported ? 'not_requested' : 'unavailable',
  };
}

export async function connectObdBleAdapter() {
  const nav = /** @type {any} */ (navigator);
  if (!nav.bluetooth) throw new Error('Web Bluetooth is not available on this device.');
  const device = await nav.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: [
      '0000fff0-0000-1000-8000-00805f9b34fb',
      '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    ],
  });
  return {
    device,
    connected: Boolean(await device.gatt?.connect()),
  };
}
