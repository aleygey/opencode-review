export type BatchRevertCandidate = {
  status: string
  attribution: string
}

export function includeInPluginBatchRevert(
  item: BatchRevertCandidate,
  deleteAgentAdded: boolean,
): boolean {
  if (item.status !== 'add') return true
  return deleteAgentAdded && item.attribution === 'agent'
}
