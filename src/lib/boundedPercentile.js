/**
 * Deterministic bounded-memory percentile estimation.
 *
 * Calibration needs percentiles over every acceleration sample in the archive.
 * Collecting those samples into an array is O(total GPS points), which is the
 * single largest unbounded allocation left in the calibration path.
 *
 * A fixed-bin histogram replaces it. Memory is a constant number of bins
 * regardless of how many samples arrive, and — unlike reservoir sampling — the
 * result is exactly reproducible for the same input, which is what lets the
 * streamed job claim result equivalence with the former array path.
 *
 * Accuracy is bounded by the bin width, which callers choose to be finer than
 * the rounding applied to the output. Values outside `[min, max]` are clamped
 * into the end bins rather than discarded, so an extreme sample still pulls a
 * high percentile toward the boundary instead of vanishing.
 */

export class BoundedPercentileHistogram {
  /**
   * @param {{min?: number, max?: number, binWidth: number}} options
   */
  constructor({ min = 0, max = 20, binWidth = 0.01 } = { binWidth: 0.01 }) {
    if (!(binWidth > 0)) throw new TypeError('binWidth must be positive');
    if (!(max > min)) throw new TypeError('max must exceed min');
    this.min = min;
    this.max = max;
    this.binWidth = binWidth;
    this.binCount = Math.ceil((max - min) / binWidth) + 1;
    this.bins = new Float64Array(this.binCount);
    this.count = 0;
    this.sum = 0;
    this.observedMin = null;
    this.observedMax = null;
  }

  add(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    const clamped = Math.min(this.max, Math.max(this.min, numeric));
    const index = Math.min(this.binCount - 1, Math.max(0, Math.round((clamped - this.min) / this.binWidth)));
    this.bins[index] += 1;
    this.count += 1;
    this.sum += numeric;
    this.observedMin = this.observedMin == null ? numeric : Math.min(this.observedMin, numeric);
    this.observedMax = this.observedMax == null ? numeric : Math.max(this.observedMax, numeric);
  }

  /** Bin midpoint value, matching how `add` assigns bins. */
  valueForBin(index) {
    return this.min + index * this.binWidth;
  }

  /**
   * Linear-interpolated percentile over the sorted sample, matching the
   * array implementation's `(n - 1) * p` index rule to within one bin width.
   *
   * @param {number} p in [0, 1]
   * @returns {number | null} null when no sample was recorded
   */
  percentile(p) {
    if (!this.count) return null;
    if (this.count === 1) return this.observedMin;
    // The array version indexes the sorted sample at (n - 1) * p. Reproduce
    // that rank here rather than the more common n * p convention, so both
    // paths select the same element.
    const targetRank = (this.count - 1) * p;
    const lowerRank = Math.floor(targetRank);
    const upperRank = Math.ceil(targetRank);
    const lowerValue = this.valueAtRank(lowerRank);
    if (lowerRank === upperRank) return lowerValue;
    const upperValue = this.valueAtRank(upperRank);
    return lowerValue + (upperValue - lowerValue) * (targetRank - lowerRank);
  }

  /** Value of the zero-based `rank`-th smallest sample. */
  valueAtRank(rank) {
    const target = Math.min(this.count - 1, Math.max(0, rank));
    let seen = 0;
    for (let index = 0; index < this.binCount; index += 1) {
      const binCount = this.bins[index];
      if (!binCount) continue;
      if (seen + binCount > target) {
        const value = this.valueForBin(index);
        // The extreme bins carry every clamped sample, so report the actual
        // observed extreme instead of the bin edge.
        if (index === 0 && this.observedMin != null) return Math.max(value, this.observedMin);
        if (index === this.binCount - 1 && this.observedMax != null) {
          return Math.min(value, this.observedMax);
        }
        return value;
      }
      seen += binCount;
    }
    return this.observedMax;
  }

  /** Serializable state, for checkpointing a partially complete job. */
  toJSON() {
    // Bins are sparse in practice; store only occupied ones.
    const occupied = [];
    for (let index = 0; index < this.binCount; index += 1) {
      if (this.bins[index]) occupied.push([index, this.bins[index]]);
    }
    return {
      min: this.min,
      max: this.max,
      binWidth: this.binWidth,
      count: this.count,
      sum: this.sum,
      observedMin: this.observedMin,
      observedMax: this.observedMax,
      bins: occupied,
    };
  }

  static fromJSON(state) {
    const histogram = new BoundedPercentileHistogram({
      min: state?.min ?? 0,
      max: state?.max ?? 20,
      binWidth: state?.binWidth ?? 0.01,
    });
    histogram.count = Number(state?.count) || 0;
    histogram.sum = Number(state?.sum) || 0;
    histogram.observedMin = state?.observedMin ?? null;
    histogram.observedMax = state?.observedMax ?? null;
    for (const [index, value] of state?.bins || []) {
      if (index >= 0 && index < histogram.binCount) histogram.bins[index] = value;
    }
    return histogram;
  }
}

/** Acceleration and deceleration in m/s^2; output is rounded to one decimal. */
export const createAccelerationHistogram = () => new BoundedPercentileHistogram({
  min: 0,
  max: 25,
  binWidth: 0.01,
});

/** Lateral force in g; output is rounded to two decimals. */
export const createLateralGHistogram = () => new BoundedPercentileHistogram({
  min: 0,
  max: 5,
  binWidth: 0.001,
});
