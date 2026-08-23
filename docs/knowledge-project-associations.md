# Knowledge Base associations with Projects

Knowledge Base nodes can be linked directly to one Projects project, epic, or task. The `work_item_knowledge_links` table is the only association store. It has real foreign keys, a one-target check, soft archive, mutation attribution, and partial unique indexes that make active links idempotent per relation type.

Preferred relations are `related_to`, `context`, `resource`, `requirement`, `decision`, `evidence`, `lesson`, and `deliverable`. This vocabulary is intentionally soft so new relation names do not require a migration.

Project tools are `project/link_knowledge_item`, `project/unlink_knowledge_item`, and `project/list_linked_knowledge`. Knowledge tools are `memory/episodic_link_project_item`, `memory/episodic_unlink_project_item`, `memory/episodic_list_linked_project_items`, `memory/episodic_search`, `memory/episodic_resolve`, and `memory/episodic_recall`. Both mutation directions call `WorkItemKnowledgeModel`; neither namespace owns a second implementation.

Links are direct records. A task lookup can include its epic and project associations, and an epic lookup can include project associations. Each result says `scope: direct` or `scope: inherited` and identifies the item where the link was created. Inheritance is computed during the query. Unlink removes only the requested direct link.

Scoped recall ranks direct associations first, inherited associations second, and ordinary node matches last. Association reads never reinforce graph edges or update Projects activity timestamps.

The Projects view includes Knowledge panels on project, epic, and task details. Its Knowledge tab is the reverse view: choose a node, inspect related work with ancestry, attach an item, detach it, or navigate back to Projects.

The model and episodic read tools restore the canonical migration-0029 surface originally merged in #523. They do not restore the pruned subconscious episodic agents or introduce a legacy `knowledgebase_sections` adapter.
