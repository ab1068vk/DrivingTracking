const GPS_POINT_WIDTH = 5;

const finiteNumber = (value) => {
  if (value == null || value === '') return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const timestampMs = (point = {}) => {
  const value = point.timestamp ?? point.time;
  if (value == null || value === '') return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
};

export class SecureGpsBuffer {
  constructor(points = []) {
    const safePoints = Array.isArray(points) ? points : [];
    this._count = safePoints.length;
    this._buf = new Float64Array(this._count * GPS_POINT_WIDTH);

    safePoints.forEach((point, index) => {
      const base = index * GPS_POINT_WIDTH;
      this._buf[base + 0] = finiteNumber(point?.lat ?? point?.latitude);
      this._buf[base + 1] = finiteNumber(point?.lng ?? point?.longitude);
      this._buf[base + 2] = timestampMs(point);
      this._buf[base + 3] = finiteNumber(point?.speed_kmh ?? point?.speedKmh ?? point?.speed);
      this._buf[base + 4] = finiteNumber(point?.heading ?? point?.bearing ?? point?.course);
    });
  }

  get(index) {
    if (!this._buf || index < 0 || index >= this._count) return null;
    const base = index * GPS_POINT_WIDTH;
    return {
      lat: this._buf[base + 0],
      lng: this._buf[base + 1],
      latitude: this._buf[base + 0],
      longitude: this._buf[base + 1],
      timestamp_ms: this._buf[base + 2],
      speed_kmh: this._buf[base + 3],
      heading: this._buf[base + 4],
    };
  }

  zero() {
    if (this._buf) {
      this._buf.fill(0);
      this._buf = null;
    }
  }

  get length() {
    return this._count;
  }
}
