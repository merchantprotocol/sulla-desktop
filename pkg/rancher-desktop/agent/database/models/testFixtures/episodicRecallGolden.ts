export interface GoldenNode {
  id:         string;
  node_type: string;
  title:     string;
  summary:   string;
  aliases:   string[];
}

export interface GoldenEdge {
  src:      string;
  dst:      string;
  strength: number;
}

export interface GoldenCase {
  name:                 string;
  terms:                string[];
  expectedAnchorId:     string;
  expectedNeighborhood: string[];
}

export const goldenNodes: GoldenNode[] = [
  { id: 'issue-517', node_type: 'issue', title: 'GitHub issue #517', summary: 'Recall agent graph retrieval for fast voice turns', aliases: ['issue 517', '#517', 'recall agent'] },
  { id: 'pr-535', node_type: 'pull_request', title: 'Draft PR #535', summary: 'Episodic recall branch that must stay draft', aliases: ['pr 535', '#535', 'draft pr'] },
  { id: 'spread-activation', node_type: 'implementation', title: 'Spreading activation CTE', summary: 'Two-hop weighted graph traversal for episodic recall', aliases: ['spread activation', 'spreading activation', 'recursive cte'] },
  { id: 'episodic-recall-tool', node_type: 'tool', title: 'episodic_recall tool', summary: 'Single SQL graph recall tool', aliases: ['episodic recall', 'episodic_recall', 'graph recall tool'] },
  { id: 'voice-latency', node_type: 'lesson', title: 'Voice latency blocker', summary: 'Legacy recall delays voice work by 40-50 seconds', aliases: ['voice latency', 'faster voice', 'voice blocker'] },
  { id: 'legacy-memory-recall', node_type: 'implementation', title: 'Legacy memory recall agent', summary: 'Slow broad research recall path', aliases: ['legacy recall', 'runMemoryRecall', 'memory recall'] },
  { id: 'statement-timeout', node_type: 'safety', title: 'Query statement timeout', summary: 'Database query guard, not an agent abort', aliases: ['statement timeout', 'query guard', 'db timeout'] },
  { id: 'node-links-invariant', node_type: 'invariant', title: 'Recall never strengthens edges', summary: 'Recall must not write node_links', aliases: ['node_links invariant', 'never strengthens edges', 'edge reinforcement'] },
  { id: 'gate-b-eval', node_type: 'test', title: 'Gate B golden eval', summary: 'Twenty query cases over the fixture graph', aliases: ['gate b', 'golden eval', 'golden query'] },
  { id: 'gate-c-latency', node_type: 'measurement', title: 'Gate C latency', summary: 'Compare new recall median to 40-50 second baseline', aliases: ['gate c', 'latency numbers', 'median latency'] },

  { id: 'observations-agent', node_type: 'agent', title: 'Observation recall agent', summary: 'Surfaces durable observation rows separately from graph recall', aliases: ['observation recall', 'observations agent', 'observationContext'] },
  { id: 'heartbeat-recall', node_type: 'agent', title: 'Heartbeat recall variant', summary: 'Loads active projects, presence, and sub-agent jobs', aliases: ['heartbeat recall', 'heartbeat variant', 'active projects recall'] },
  { id: 'subconscious-middleware', node_type: 'implementation', title: 'SubconsciousMiddleware', summary: 'Dispatches recall before the primary agent turn', aliases: ['subconscious middleware', 'middleware recall', 'prelude'] },
  { id: 'agent-node-injection', node_type: 'implementation', title: 'AgentNode context injection', summary: 'Injects recall and observation blocks into assistant context', aliases: ['agentnode injection', 'context injection', 'episodic_context'] },
  { id: 'base-node-stripper', node_type: 'implementation', title: 'BaseNode injected context stripper', summary: 'Removes old injected context blocks before reinjection', aliases: ['stripInjectedContextBlocks', 'context stripper', 'strip injected context'] },

  { id: 'sulla-desktop', node_type: 'project', title: 'Sulla Desktop', summary: 'Jonathon’s autonomous desktop agent platform', aliases: ['sulla desktop', 'desktop app', 'sulla'] },
  { id: 'voice-mode', node_type: 'feature', title: 'Voice mode', summary: 'Microphone-driven turn flow that needs fast recall', aliases: ['voice mode', 'microphone', 'voice work'] },
  { id: 'faster-voice-branch', node_type: 'branch', title: 'Faster voice work', summary: 'Blocked until graph recall is merge-ready', aliases: ['faster voice branch', 'voice branch', 'voice work branch'] },
  { id: 'turn-context', node_type: 'implementation', title: 'Turn context injection', summary: 'Small dynamic context added to the latest user message', aliases: ['turn context', 'turn_context', 'dynamic context'] },
  { id: 'prompt-cache', node_type: 'optimization', title: 'Prompt cache stability', summary: 'Stable prompt prefix avoids resending static context', aliases: ['prompt cache', 'cache stability', 'stable prompt'] },

  { id: 'data-ripple-mobile', node_type: 'project', title: 'Data Ripple Mobile', summary: 'Mobile app theme and sync work', aliases: ['data ripple mobile', 'ripple mobile', 'dr mobile'] },
  { id: 'theme-alignment', node_type: 'task', title: 'Theme alignment', summary: 'Align light and dark modes to website teal branding', aliases: ['theme alignment', 'teal theme', 'light mode theme'] },
  { id: 'camera-capture-screen', node_type: 'screen', title: 'CameraCaptureScreen', summary: 'Media screen with intentional white and black overlays', aliases: ['camera capture', 'CameraCaptureScreen', 'camera screen'] },
  { id: 'photo-viewer-screen', node_type: 'screen', title: 'PhotoViewerScreen', summary: 'Photo review screen with media overlays', aliases: ['photo viewer', 'PhotoViewerScreen', 'photo screen'] },
  { id: 'icon-theme', node_type: 'task', title: 'Icon theme awareness', summary: 'Icon default color must follow theme', aliases: ['icon theme', 'Icon.tsx', 'theme-aware icons'] },

  { id: 'relay-persistence', node_type: 'feature', title: 'Relay server persistence', summary: 'Desktop scribes mobile relay conversations', aliases: ['relay persistence', 'relay server persistence', 'scribeRelayTurn'] },
  { id: 'sync-mirror', node_type: 'implementation', title: 'syncMirror relay scribe', summary: 'Writes local messages and sync_queue entries', aliases: ['syncMirror', 'scribe relay turn', 'sync mirror'] },
  { id: 'chat-message-endpoint', node_type: 'worker', title: 'Workers chat message endpoint', summary: 'Optional POST endpoint for chat messages', aliases: ['chat message endpoint', 'workers endpoint', 'message write endpoint'] },
  { id: 'mobile-hydration', node_type: 'feature', title: 'Mobile chat hydration', summary: 'Hydrates conversations and tool rows on mobile', aliases: ['mobile hydration', 'chat hydration', 'tool rows'] },
  { id: 'resync-cloud', node_type: 'feature', title: 'Resync from Cloud', summary: 'Settings action to wipe and resnapshot mobile sync', aliases: ['resync from cloud', 'cloud resync', 'wipeDatabase'] },

  { id: 'observations-table', node_type: 'feature', title: 'Observations table', summary: 'Dedicated table for durable observational memory', aliases: ['observations table', 'observational memory', 'memory table'] },
  { id: 'observations-importer', node_type: 'implementation', title: 'ObservationsImportSeeder', summary: 'Runtime importer for local legacy observation blob', aliases: ['ObservationsImportSeeder', 'observation importer', 'runtime importer'] },
  { id: 'no-user-data-migrations', node_type: 'rule', title: 'No user data in migrations', summary: 'Production migrations must stay schema-only', aliases: ['no user data in migrations', 'schema-only migrations', 'migration rule'] },
  { id: 'writer-agent-dedup', node_type: 'agent', title: 'Observation writer dedupe', summary: 'Search-before-add and soft-archive behavior', aliases: ['writer dedupe', 'search before add', 'soft archive'] },
  { id: 'recall-dispatch-bug', node_type: 'bug', title: 'Recall dispatch empty payload bug', summary: 'Recall fired without latest user message payload', aliases: ['empty payload bug', 'recall dispatch bug', 'bare instruction'] },

  { id: 'merchant-protocol', node_type: 'business', title: 'Merchant Protocol', summary: 'Jonathon’s automation and software business', aliases: ['merchant protocol', 'mp', 'business'] },
  { id: 'reborn-exteriors', node_type: 'business', title: 'Reborn Exteriors', summary: 'Business priority ahead of content pipeline', aliases: ['reborn exteriors', 'reborn', 'exteriors'] },
  { id: 'youtube-pipeline', node_type: 'project', title: 'YouTube pipeline', summary: 'Content pipeline ranked after Reborn Exteriors', aliases: ['youtube pipeline', 'youtube', 'content pipeline'] },
  { id: 'blog-pipeline', node_type: 'project', title: 'Blog pipeline', summary: 'Ready but not producing', aliases: ['blog pipeline', 'blog', 'ready not producing'] },
  { id: 'active-projects', node_type: 'document', title: 'ACTIVE_PROJECTS.md', summary: 'Realigned project priorities and on-hold MP acquisition', aliases: ['active projects', 'ACTIVE_PROJECTS.md', 'project priorities'] },
];

function clusterEdges(ids: string[], strength: number, span: number): GoldenEdge[] {
  const edges: GoldenEdge[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < Math.min(ids.length, i + span + 1); j++) {
      edges.push({ src: ids[i], dst: ids[j], strength });
    }
  }
  return edges;
}

export const goldenEdges: GoldenEdge[] = [
  ...clusterEdges(['issue-517', 'pr-535', 'spread-activation', 'episodic-recall-tool', 'voice-latency', 'legacy-memory-recall', 'statement-timeout', 'node-links-invariant', 'gate-b-eval', 'gate-c-latency'], 0.82, 3),
  ...clusterEdges(['observations-agent', 'heartbeat-recall', 'subconscious-middleware', 'agent-node-injection', 'base-node-stripper', 'observations-table', 'writer-agent-dedup', 'recall-dispatch-bug'], 0.72, 3),
  ...clusterEdges(['sulla-desktop', 'voice-mode', 'faster-voice-branch', 'turn-context', 'prompt-cache', 'subconscious-middleware', 'agent-node-injection'], 0.76, 3),
  ...clusterEdges(['data-ripple-mobile', 'theme-alignment', 'camera-capture-screen', 'photo-viewer-screen', 'icon-theme'], 0.78, 2),
  ...clusterEdges(['relay-persistence', 'sync-mirror', 'chat-message-endpoint', 'mobile-hydration', 'resync-cloud', 'data-ripple-mobile'], 0.74, 2),
  ...clusterEdges(['observations-table', 'observations-importer', 'no-user-data-migrations', 'writer-agent-dedup', 'observations-agent'], 0.8, 2),
  ...clusterEdges(['merchant-protocol', 'reborn-exteriors', 'youtube-pipeline', 'blog-pipeline', 'active-projects'], 0.7, 2),
  { src: 'issue-517', dst: 'subconscious-middleware', strength: 0.88 },
  { src: 'issue-517', dst: 'agent-node-injection', strength: 0.84 },
  { src: 'episodic-recall-tool', dst: 'observations-agent', strength: 0.45 },
  { src: 'voice-latency', dst: 'voice-mode', strength: 0.9 },
  { src: 'faster-voice-branch', dst: 'issue-517', strength: 0.86 },
  { src: 'recall-dispatch-bug', dst: 'legacy-memory-recall', strength: 0.62 },
  { src: 'no-user-data-migrations', dst: 'issue-517', strength: 0.35 },
  { src: 'sulla-desktop', dst: 'merchant-protocol', strength: 0.5 },
  { src: 'data-ripple-mobile', dst: 'mobile-hydration', strength: 0.76 },
  { src: 'relay-persistence', dst: 'sulla-desktop', strength: 0.42 },
  { src: 'active-projects', dst: 'heartbeat-recall', strength: 0.52 },
];

export const goldenCases: GoldenCase[] = [
  { name: 'issue recall', terms: ['issue 517'], expectedAnchorId: 'issue-517', expectedNeighborhood: ['episodic-recall-tool', 'spread-activation'] },
  { name: 'draft pr', terms: ['pr 535'], expectedAnchorId: 'pr-535', expectedNeighborhood: ['issue-517', 'episodic-recall-tool'] },
  { name: 'activation cte', terms: ['recursive cte'], expectedAnchorId: 'spread-activation', expectedNeighborhood: ['episodic-recall-tool', 'statement-timeout'] },
  { name: 'episodic tool', terms: ['episodic_recall'], expectedAnchorId: 'episodic-recall-tool', expectedNeighborhood: ['issue-517', 'legacy-memory-recall'] },
  { name: 'voice blocker', terms: ['faster voice'], expectedAnchorId: 'voice-latency', expectedNeighborhood: ['voice-mode', 'legacy-memory-recall'] },
  { name: 'legacy path', terms: ['runMemoryRecall'], expectedAnchorId: 'legacy-memory-recall', expectedNeighborhood: ['voice-latency', 'recall-dispatch-bug'] },
  { name: 'db guard', terms: ['statement timeout'], expectedAnchorId: 'statement-timeout', expectedNeighborhood: ['issue-517', 'episodic-recall-tool'] },
  { name: 'edge invariant', terms: ['never strengthens edges'], expectedAnchorId: 'node-links-invariant', expectedNeighborhood: ['legacy-memory-recall', 'gate-b-eval'] },
  { name: 'golden gate', terms: ['gate b'], expectedAnchorId: 'gate-b-eval', expectedNeighborhood: ['statement-timeout', 'node-links-invariant'] },
  { name: 'latency gate', terms: ['latency numbers'], expectedAnchorId: 'gate-c-latency', expectedNeighborhood: ['statement-timeout', 'node-links-invariant'] },
  { name: 'observation recall', terms: ['observationContext'], expectedAnchorId: 'observations-agent', expectedNeighborhood: ['observations-table', 'writer-agent-dedup'] },
  { name: 'heartbeat recall', terms: ['heartbeat variant'], expectedAnchorId: 'heartbeat-recall', expectedNeighborhood: ['active-projects', 'subconscious-middleware'] },
  { name: 'middleware prelude', terms: ['subconscious middleware'], expectedAnchorId: 'subconscious-middleware', expectedNeighborhood: ['agent-node-injection', 'issue-517'] },
  { name: 'agent injection', terms: ['episodic_context'], expectedAnchorId: 'agent-node-injection', expectedNeighborhood: ['base-node-stripper', 'subconscious-middleware'] },
  { name: 'stripper', terms: ['stripInjectedContextBlocks'], expectedAnchorId: 'base-node-stripper', expectedNeighborhood: ['agent-node-injection', 'observations-agent'] },
  { name: 'theme work', terms: ['teal theme'], expectedAnchorId: 'theme-alignment', expectedNeighborhood: ['data-ripple-mobile', 'icon-theme'] },
  { name: 'camera screen', terms: ['CameraCaptureScreen'], expectedAnchorId: 'camera-capture-screen', expectedNeighborhood: ['theme-alignment', 'photo-viewer-screen'] },
  { name: 'relay persistence', terms: ['scribeRelayTurn'], expectedAnchorId: 'relay-persistence', expectedNeighborhood: ['sync-mirror', 'mobile-hydration'] },
  { name: 'migration rule', terms: ['schema-only migrations'], expectedAnchorId: 'no-user-data-migrations', expectedNeighborhood: ['observations-importer', 'observations-table'] },
  { name: 'active projects', terms: ['ACTIVE_PROJECTS.md'], expectedAnchorId: 'active-projects', expectedNeighborhood: ['reborn-exteriors', 'heartbeat-recall'] },
];
