/**
 * Per-user visibility filter for memory/conversation search results.
 *
 * Isolation semantics:
 * - Rows carry user_id (written by capture since the identity fix).
 * - A scoped query (userId set) sees only its own rows.
 * - The configured owner additionally sees legacy user_id='default' rows
 *   (pre-fix pool, retroactively unattributable).
 * - Unscoped calls (userId undefined) see everything — internal/seed paths only.
 */
export function memoryVisibleTo(
  rowUserId: string | undefined,
  queryUserId: string | undefined,
  ownerUserId: string | undefined,
): boolean {
  if (!queryUserId) return true;
  const row = rowUserId || "default";
  if (row === queryUserId) return true;
  if (row === "default" && ownerUserId && queryUserId === ownerUserId) return true;
  return false;
}
