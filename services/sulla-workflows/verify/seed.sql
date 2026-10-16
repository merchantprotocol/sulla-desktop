INSERT INTO function_definitions (slug, name, manifest, runtime, files, version) VALUES (
  'verify-node-function',
  'Verify node function',
  '{"apiVersion":"sulla/v1","kind":"Function","slug":"verify-node-function","name":"Verify node function","spec":{"runtime":"node","entrypoint":"main.js::handler","inputs":{"text":{"type":"string"}},"outputs":{"runtime":{"type":"string"},"value":{"type":"string"}},"timeout":"10s"}}',
  'node',
  '{"main.js":{"content":"ZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGhhbmRsZXIoaW5wdXRzKSB7IHJldHVybiB7IHJ1bnRpbWU6ICdub2RlLWNvbnRhaW5lcicsIHZhbHVlOiBTdHJpbmcoaW5wdXRzLnRleHQgfHwgJycpLnRvVXBwZXJDYXNlKCkgfTsgfQ==","encoding":"base64"}}',
  '1.0.0'
);

INSERT INTO workflows (id, name, status, enabled, definition) VALUES (
  'verify-child', 'Verify child', 'production', TRUE,
  '{"id":"verify-child","slug":"verify-child","name":"Verify child","nodes":[{"id":"child-trigger","type":"workflow","position":{"x":0,"y":0},"data":{"category":"trigger","subtype":"sulla-desktop","label":"Child trigger","config":{}}},{"id":"child-tool","type":"workflow","position":{"x":100,"y":0},"data":{"category":"agent","subtype":"tool-call","label":"Child tool","config":{"toolName":"verify_echo","defaults":{"child":"ok"}}}}],"edges":[{"id":"ce1","source":"child-trigger","target":"child-tool"}]}'
),
(
  'verify-main', 'Verify main', 'production', TRUE,
  '{"id":"verify-main","slug":"verify-main","name":"Verify main","nodes":[{"id":"schedule","type":"workflow","position":{"x":0,"y":0},"data":{"category":"trigger","subtype":"schedule","label":"Every minute","config":{"frequency":"every-minutes","intervalMinutes":1,"timezone":"UTC"}}},{"id":"condition","type":"workflow","position":{"x":100,"y":0},"data":{"category":"routing","subtype":"condition","label":"Condition","config":{"rules":[{"field":"trigger","operator":"contains","value":"trigger"}],"combinator":"and"}}},{"id":"tool","type":"workflow","position":{"x":200,"y":0},"data":{"category":"agent","subtype":"tool-call","label":"Tool call","config":{"toolName":"verify_echo","defaults":{"message":"{{trigger}}"}}}},{"id":"function","type":"workflow","position":{"x":300,"y":0},"data":{"category":"action","subtype":"function","label":"Node runtime","config":{"functionRef":"verify-node-function","inputs":{"text":"container"}}}},{"id":"wait","type":"workflow","position":{"x":400,"y":0},"data":{"category":"flow","subtype":"wait","label":"Fresh runner wait","config":{"delayAmount":2,"delayUnit":"seconds"}}},{"id":"child","type":"workflow","position":{"x":500,"y":0},"data":{"category":"flow","subtype":"sub-workflow","label":"Child workflow","config":{"workflowId":"verify-child","awaitResponse":true}}}],"edges":[{"id":"e1","source":"schedule","target":"condition","sourceHandle":"default","targetHandle":"default"},{"id":"e2","source":"condition","target":"tool","sourceHandle":"condition-true","targetHandle":"default"},{"id":"e3","source":"tool","target":"function"},{"id":"e4","source":"function","target":"wait"},{"id":"e5","source":"wait","target":"child"}]}'
);
