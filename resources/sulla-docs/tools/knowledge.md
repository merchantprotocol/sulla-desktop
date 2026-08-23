# Knowledge Base / Projects associations

The associative Knowledge Base is `knowledge_nodes`, `node_aliases`, and `node_links`. Projects stays authoritative in `work_projects → work_epics → work_tasks`. Their only cross-domain store is `work_item_knowledge_links`.

Use `project/link_knowledge_item`, `project/unlink_knowledge_item`, and `project/list_linked_knowledge` from the Projects side. Use `memory/episodic_link_project_item`, `memory/episodic_unlink_project_item`, and `memory/episodic_list_linked_project_items` from the Knowledge Base side. Both adapters call `WorkItemKnowledgeModel`.

`memory/episodic_search` and `memory/episodic_resolve` are read-only node discovery. `memory/episodic_recall` accepts one optional `project_id`, `epic_id`, or `task_id`; it ranks direct links, inherited parent links, then ordinary results. Reads do not reinforce graph edges or touch Projects activity ordering.

Project, epic, and task panels show linked knowledge. The Knowledge tab in Projects shows reverse-linked work, ancestry, relation, note, and attribution. Detach acts only on the direct association selected.
