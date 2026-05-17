export function parseObdPidResponse(raw = '') {
  const cleaned = String(raw).replace(/[>\r\n]/g, ' ').trim().toUpperCase();
  const bytes = cleaned.split(/\s+/).filter(Boolean);
  const modeIndex = bytes.findIndex((byte) => byte === '41');
  if (modeIndex < 0 || bytes.length < modeIndex + 3) return null;
  const pid = bytes[modeIndex + 1];
  const data = bytes.slice(modeIndex + 2).map((byte) => Number.parseInt(byte, 16));
  if (data.some((value) => !Number.isFinite(value))) return null;

  if (pid === '0C' && data.length >= 2) {
    return { pid, label: 'RPM', value: ((data[0] * 256) + data[1]) / 4, unit: 'rpm' };
  }
  if (pid === '11' && data.length >= 1) {
    return { pid, label: 'Throttle', value: Math.round((data[0] * 100) / 255), unit: '%' };
  }
  if (pid === '04' && data.length >= 1) {
    return { pid, label: 'Engine Load', value: Math.round((data[0] * 100) / 255), unit: '%' };
  }
  if (pid === '0D' && data.length >= 1) {
    return { pid, label: 'Vehicle Speed', value: data[0], unit: 'km/h' };
  }
  if (pid === '05' && data.length >= 1) {
    return { pid, label: 'Coolant Temp', value: data[0] - 40, unit: 'C' };
  }
  return { pid, label: `PID ${pid}`, value: data[0] ?? null, unit: '' };
}

export function getObdBluetoothSupport() {
  const supported = typeof navigator !== 'undefined' && Boolean(navigator.bluetooth);
  return {
    supported,
    transport: supported ? 'web_bluetooth_ble' : 'unavailable',
    note: supported
      ? 'Supports BLE OBD-II adapters that expose a writable/readable serial characteristic.'
      : 'This browser/WebView does not expose Web Bluetooth. Classic Bluetooth OBD-II requires a native plugin.',
  };
}

export async function connectObdBleAdapter() {
  if (!navigator.bluetooth) throw new Error('Web Bluetooth is not available on this device.');
  const device = await navigator.bluetooth.requestDevice({
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
