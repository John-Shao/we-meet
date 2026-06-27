/** Standard DRF pagination envelope, shared across feature APIs. */
export interface Paginated<T> {
  count: number
  next: string | null
  previous: string | null
  results: T[]
}
