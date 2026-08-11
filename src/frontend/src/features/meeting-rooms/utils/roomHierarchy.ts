/**
 * Tree helpers for the meeting-room hierarchy (P9).
 *
 * The server sends a flat list with a materialized `path`; clients build the
 * tree. Same shape as the department tree, so the same rules apply — notably
 * that a node whose parent was filtered out must still be rendered, at the root,
 * rather than silently vanishing.
 */

import type {
  MeetingRoomLevelType,
  MeetingRoomNode,
} from '../api/ApiMeetingRoom'

type LevelSelection = Partial<Record<MeetingRoomLevelType, string>>

/** Keep only campus → building → floor, joined as one address hierarchy. */
export const compactRoomPathLabel = (
  pathLabel: string,
  separator = '-'
): string =>
  pathLabel
    .split('·')
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(-3)
    .join(separator)

/** Resolve one selected node into its root-to-leaf cascade values. */
export const selectionByLevel = (
  nodes: MeetingRoomNode[],
  selectedNodeId?: string | null
): LevelSelection => {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const selection: LevelSelection = {}
  let current = selectedNodeId ? byId.get(selectedNodeId) : undefined
  const seen = new Set<string>()

  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    selection[current.level_type] = current.id
    current = current.parent ? byId.get(current.parent) : undefined
  }
  return selection
}

/** Children keyed by parent id; roots (and orphans) live under `''`. */
export const childrenOf = (
  nodes: MeetingRoomNode[]
): Map<string, MeetingRoomNode[]> => {
  const ids = new Set(nodes.map((n) => n.id))
  const map = new Map<string, MeetingRoomNode[]>()
  for (const node of nodes) {
    // An orphan (parent filtered away) falls back to the root list — dropping
    // it would hide its rooms with no way for the admin to notice.
    const key = node.parent && ids.has(node.parent) ? node.parent : ''
    const bucket = map.get(key)
    if (bucket) bucket.push(node)
    else map.set(key, [node])
  }
  return map
}

/** A node's id plus every descendant's — the "include sub-levels" filter. */
export const descendantIds = (
  nodes: MeetingRoomNode[],
  rootId: string
): string[] => {
  const root = nodes.find((n) => n.id === rootId)
  if (!root) return []
  return nodes.filter((n) => n.path.startsWith(root.path)).map((n) => n.id)
}

/** 「北京-A 座-3F」 built from the flat list, for client-side labels. */
export const pathLabelOf = (
  nodes: MeetingRoomNode[],
  nodeId: string,
  separator = '-'
): string => {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const node = byId.get(nodeId)
  if (!node) return ''
  const names: string[] = []
  const hexes = node.path.split('/').filter(Boolean)
  for (const hex of hexes) {
    // `path` stores ids without dashes; match on the stripped form.
    const match = nodes.find((n) => n.id.replace(/-/g, '') === hex)
    if (match) names.push(match.name)
  }
  return names.length ? names.join(separator) : node.name
}

/**
 * Nodes that may host `nodeId` after a move — everything but itself and its
 * own descendants (moving a level under its own child would make a cycle).
 */
export const validMoveTargets = (
  nodes: MeetingRoomNode[],
  nodeId: string
): MeetingRoomNode[] => {
  const node = nodes.find((n) => n.id === nodeId)
  if (!node) return nodes
  return nodes.filter((n) => !n.path.startsWith(node.path))
}

/** Flatten to a depth-ordered list, for indented `<select>` options. */
export const flattenTree = (
  nodes: MeetingRoomNode[]
): { node: MeetingRoomNode; indent: string }[] => {
  const map = childrenOf(nodes)
  const out: { node: MeetingRoomNode; indent: string }[] = []
  const walk = (parentId: string, depth: number) => {
    for (const node of map.get(parentId) ?? []) {
      out.push({ node, indent: '  '.repeat(depth) })
      walk(node.id, depth + 1)
    }
  }
  walk('', 0)
  return out
}
