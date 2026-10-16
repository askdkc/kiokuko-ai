/** Required scalar-vector API, tested with actual float32 blobs; version is metadata. */
export function probeSqliteVec(database: { prepare(sql: string): { get(...parameters: Uint8Array[]): unknown } }): { available: boolean; version: string | null } {
  try {
    const blob = (values: number[]) => new Uint8Array(new Float32Array(values).buffer);
    const x = blob([1, 0]), y = blob([0, 1]), minusX = blob([-1, 0]);
    const row = database.prepare('SELECT vec_distance_cosine(?, ?) AS same, vec_distance_cosine(?, ?) AS orthogonal, vec_distance_cosine(?, ?) AS opposite').get(x, x, x, y, x, minusX) as Record<string, unknown> | undefined;
    if (!row || ![row.same, row.orthogonal, row.opposite].every((value, index) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value - index) < 1e-6)) return { available: false, version: null };
    let version: string | null = null;
    try {
      const value = (database.prepare('SELECT vec_version() AS version').get() as Record<string, unknown> | undefined)?.version;
      if (typeof value === 'string' && value.length > 0 && value.length <= 100 && !/[\p{Cc}\p{Cf}]/u.test(value)) version = value;
    } catch { /* metadata is not the vector API */ }
    return { available: true, version };
  } catch { return { available: false, version: null }; }
}
