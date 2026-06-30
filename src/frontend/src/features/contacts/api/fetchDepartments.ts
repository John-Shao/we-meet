import { fetchApi } from '@/api/fetchApi'

import type { DirectoryDepartment } from './ApiDirectory'

/**
 * GET /api/v1.0/directory/departments — the caller org's department tree (flat,
 * ordered by path). Pass `parentId` to lazily fetch only direct children.
 *
 * Unpaginated (trees are small) — the backend returns a plain array.
 */
export const fetchDepartments = (
  parentId?: string,
): Promise<DirectoryDepartment[]> => {
  const qs = parentId ? `?parent=${encodeURIComponent(parentId)}` : ''
  return fetchApi<DirectoryDepartment[]>(`/directory/departments/${qs}`)
}
